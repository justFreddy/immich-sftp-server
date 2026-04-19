import { VirtualFileSystem } from "./virtual-file-system";
import axios from 'axios';
import FormData from 'form-data';
import crypto from 'crypto';
import { config } from './config';
import fs from 'fs';
import tmp from 'tmp';
import { Readable } from 'stream';
import { pipeline } from 'stream/promises';
import { DateTime } from 'luxon';
import isValidFilename from 'valid-filename'; //Achtung, nicht auf v4.0.0 updaten. Ab da wird commjs projekt nicht mehr unterstützt, es geht dann nur noch als ES module.
import {
    ALBUM_METADATA_FILE_NAME,
    ALBUM_BROWSER_LINK_FILE_NAME,
    AlbumMetadataSharedUser,
    buildAlbumBrowserLink,
    buildAlbumMetadataDocument,
    buildAlbumMetadataYaml,
    getChangedImmutableAlbumMetadataFields,
    hasNoSyncTag,
    isAlbumBrowserLinkFileName,
    isAlbumMetadataFileName,
    mergeNoSyncTag,
    parseAndValidateAlbumMetadataYaml,
    sameSharedUsers
} from './album-metadata';

// JSON-basiertes VirtualFileSystem-Backend
export class ImmichFileSystem implements VirtualFileSystem {

    private immichAccessToken: string = '';
    private albumsCache: ImmichAlbum[] = [];
    private uploadQueue: Array<{ filename: string; tmpFile: tmp.FileResult }> = [];
    private currentUser: ImmichUser | null = null;

    async login(username: string, password: string): Promise<void> {
        const loginResp = await this.immichRequest({
            method: 'POST',
            endpoint: 'auth/login',
            data: JSON.stringify({
                email: username,
                password: password,
            }),
            logAction: 'Login'
        });

        // Store the access token
        this.immichAccessToken = loginResp.accessToken;

        // Try to get current user from login response first
        this.currentUser = this.extractCurrentUser(loginResp.user, username);

        // Fallback to users/me endpoint
        if (!this.currentUser?.id || !this.currentUser?.username) {
            await this.fetchCurrentUser(username);
        }
    }
    async logout(): Promise<void> {
        await this.immichRequest({
            method: 'POST',
            endpoint: 'auth/logout',
            logAction: 'Logout'
        });
        this.currentUser = null;
    }

    async setAttributes(filename: string, mtime: number): Promise<void> {
        // Metadata/link files are applied on CLOSE and don't need SETSTAT handling
        if (this.isVirtualAlbumFile(filename)) {
            return;
        }

        // Check if the file exists in the upload queue
        const fileEntry = this.uploadQueue.find(f => f.filename === filename);
        if (!fileEntry) {
            throw new Error(`File not found in upload queue: ${filename}`);
        }

        // Get the album from the cache
        const album = await this.getAlbumFromCache(filename, false);

        // Calculate SHA-1 checksum of the buffer
        const hash = crypto.createHash('sha1');
        await pipeline(fs.createReadStream(fileEntry.tmpFile.name), hash);
        const checksum = hash.digest('base64');

        // Check if the asset already exists using bulk-upload-check
        const bulkCheckResponse = await this.immichRequest({
            method: 'POST',
            endpoint: 'assets/bulk-upload-check',
            data: JSON.stringify({
                assets: [
                    {
                        checksum: checksum,
                        id: filename,
                    }
                ]
            }),
            logAction: 'Bulk upload check'
        });

        // Parse response
        const result = bulkCheckResponse.results[0];
        const action = result.action;
        let assetId = result.assetId;
        const isTrashed = result.isTrashed;
        const reason = result.reason;
        console.log(`Bulk check result for '${filename}': action=${action}, assetId=${assetId}, isTrashed=${isTrashed}, reason=${reason}`);

        // If the asset doen't exist, upload it
        if (action == "accept") {

            // Prepare form data
            const data = new FormData();
            const isoWithOffset = DateTime.fromSeconds(mtime, { zone: config.TZ }).toISO();
            data.append('fileModifiedAt', isoWithOffset);
            data.append('fileCreatedAt', isoWithOffset);
            data.append('deviceAssetId', filename); // Use fileName as deviceAssetId
            data.append('deviceId', 'immich-sftp-server');
            data.append('albumId', album.id);

            // Add stream from tmp file
            const readStream = fs.createReadStream(fileEntry.tmpFile.name);
            data.append('assetData', readStream, { filename: filename });

            // Send the upload request to Immich
            const uploadResponse = await this.immichRequest({
                method: 'POST',
                endpoint: 'assets',
                data: data,
                logAction: 'Upload asset'
            });

            // Close tmp file after successful upload
            fileEntry.tmpFile.removeCallback();

            // Get the new asset id
            assetId = uploadResponse.id;
        }

        //Restore the asset if it is in the trash
        if (action == "reject" && isTrashed == true) {

            //Remove the trashed asset from other albums, in case it has some
            const assigedAlbums = await this.fetchAlbumsForAssetId(assetId);
            if (assigedAlbums && assigedAlbums.length > 0) {
                for (const assigedAlbum of assigedAlbums) {
                    await this.removeAssetFromAlbum(assigedAlbum, assetId);
                }
            }

            //Restore the asset from the trash
            await this.immichRequest({
                method: 'POST',
                endpoint: 'trash/restore/assets',
                data: JSON.stringify({ ids: [assetId] }),
                logAction: 'Restore asset'
            });
        }

        // Add the new asset to the album
        await this.immichRequest({
            method: 'PUT',
            endpoint: `albums/${album.id}/assets`,
            data: JSON.stringify({
                ids: [assetId]
            }),
            logAction: 'Add asset to album'
        });

    }
    async listFiles(currentDir: string): Promise<Array<{ name: string; isDir: boolean; size: number; mtime: number }>> {
        try {
            if (currentDir == "/") {

                //Get all albums from Immich API
                this.albumsCache = await this.fetchAlbums();

                //Map albums to the expected format
                return this.albumsCache.map((album) => ({
                    name: album.albumName,
                    isDir: true,
                    size: 0,
                    mtime: 0,
                }));
            }
            else {
                // Get album and fetch assets
                const album = await this.getAlbumFromCache(currentDir, false);
                await this.fetchAssetsForAlbum(album);

                // Map assets to the expected format
                const files = (album.assets ?? []).map((asset) => ({
                    name: asset.originalFileName,
                    isDir: false,
                    size: asset.fileSizeInByte,
                    mtime: new Date(asset.fileModifiedAt).getTime() / 1000, // Convert to seconds
                }));

                // Add virtual album metadata/link files
                const metadataContent = this.buildAlbumMetadataYaml(album);
                const linkContent = this.buildAlbumBrowserLink(album);

                files.push({
                    name: ALBUM_METADATA_FILE_NAME,
                    isDir: false,
                    size: Buffer.byteLength(metadataContent, 'utf8'),
                    mtime: this.getAlbumMtime(album),
                });
                files.push({
                    name: ALBUM_BROWSER_LINK_FILE_NAME,
                    isDir: false,
                    size: Buffer.byteLength(linkContent, 'utf8'),
                    mtime: this.getAlbumMtime(album),
                });

                return files;
            }
        }
        catch (error) {
            console.error("Error fetching albums:", error);
            throw error;
        }
    }
    async readFile(filename: string): Promise<tmp.FileResult> {
        if (this.isAlbumMetadataFilePath(filename)) {
            const album = await this.getAlbumFromCache(filename, false);
            await this.fetchAssetsForAlbum(album);
            return this.tmpFileFromString(this.buildAlbumMetadataYaml(album));
        }

        if (this.isAlbumBrowserLinkFilePath(filename)) {
            const album = await this.getAlbumFromCache(filename, false);
            await this.fetchAssetsForAlbum(album);
            return this.tmpFileFromString(this.buildAlbumBrowserLink(album));
        }

        //todo refactor this: Stream not Buffer, Check and refresh cache

        // Get the asset from the cache
        const asset = await this.getAssetFromCache(filename, false);

        // Fetch the original file as a buffer
        const responseStream: Readable = await this.immichRequest({
            method: 'GET',
            endpoint: `assets/${asset.id}/original`,
            logAction: 'Download asset',
            respAsStream: true
        });

        //Open tmp file stream
        const tmpFile = tmp.fileSync();
        const writeStream = fs.createWriteStream(tmpFile.name);

        //Write the immich stream to the tmp file
        await pipeline(responseStream, writeStream);
        return tmpFile;
    }
    async writeFile(filename: string, tmpFile: tmp.FileResult): Promise<void> {
        if (this.isAlbumMetadataFilePath(filename)) {
            const album = await this.getAlbumFromCache(filename, false);
            await this.fetchAssetsForAlbum(album);
            const content = fs.readFileSync(tmpFile.name, 'utf8');
            tmpFile.removeCallback();
            await this.applyAlbumMetadataFileContent(album, content);
            this.albumsCache = await this.fetchAlbums();
            return;
        }

        if (this.isAlbumBrowserLinkFilePath(filename)) {
            tmpFile.removeCallback();
            throw new Error(`'${ALBUM_BROWSER_LINK_FILE_NAME}' is read-only.`);
        }

        this.uploadQueue.push({ filename, tmpFile });
    }
    async stat(filename: string): Promise<{ isDir: boolean; size: number; mtime: number; } | null> {
        // Determine if the path is a directory (album) or a file (asset)
        const pathInfo = this.extractPathInfo(filename);

        if (pathInfo.fileName === null) {
            // It's a directory (album)
            const album = await this.getAlbumOrNullFromCache(filename, true);
            if (album) {
                return {
                    isDir: true,
                    size: 0,    // Albums don't have a size
                    mtime: 0,   // Albums don't have a modification time
                };
            }
            return null; // Album not found

        } else {
            if (this.isVirtualAlbumFile(filename)) {
                const album = await this.getAlbumOrNullFromCache(filename, true);
                if (!album) {
                    return null;
                }

                if (this.isAlbumMetadataFilePath(filename)) {
                    const metadata = this.buildAlbumMetadataYaml(album);
                    return {
                        isDir: false,
                        size: Buffer.byteLength(metadata, 'utf8'),
                        mtime: this.getAlbumMtime(album),
                    };
                }

                const link = this.buildAlbumBrowserLink(album);
                return {
                    isDir: false,
                    size: Buffer.byteLength(link, 'utf8'),
                    mtime: this.getAlbumMtime(album),
                };
            }

            // It's a file (asset)
            const asset = await this.getAssetOrNullFromCache(filename, true);
            if (asset) {
                return {
                    isDir: false,
                    size: asset.fileSizeInByte,
                    mtime: new Date(asset.fileModifiedAt).getTime() / 1000, // Convert to seconds
                };
            }
            // Asset not found
            return null;
        }
    }
    async rename(oldName: string, newName: string): Promise<void> {
        if (this.isVirtualAlbumFile(oldName) || this.isVirtualAlbumFile(newName)) {
            throw new Error('Renaming virtual album files is not supported.');
        }

        // Check if the file exists in the upload queue
        const fileIndex = this.uploadQueue.findIndex(f => f.filename === oldName);

        //rename
        if (fileIndex !== -1) {
            this.uploadQueue[fileIndex].filename = newName;
            return; // Renaming in the upload queue is successful
        }

        //File not found
        throw new Error("Rename not support for Immich backend. Expect for tmp files (files that have been upload with OPEN, WRITE, CLOSE, but not jet sent to Immich in SETSTAT).");
    }
    async remove(filename: string): Promise<void> {

        // Check if the path is a file, not a directory
        const pathInfo = this.extractPathInfo(filename);

        //Check if it is an album
        if (pathInfo.albumName != null && pathInfo.fileName == null) {
            const album = await this.getAlbumFromCache(filename, false);
            await this.fetchAssetsForAlbum(album);

            //Delete all assets in the album
            for (const asset of album.assets ?? []) {
                await this.deleteAsset(album, asset);
            }

            // Delete the album itself
            await this.immichRequest({
                method: 'DELETE',
                endpoint: `albums/${album.id}`,
                logAction: 'Delete album'
            });

        }

        // Check if the path is a file (asset)
        if (pathInfo.albumName != null && pathInfo.fileName != null) {
            if (this.isVirtualAlbumFile(filename)) {
                throw new Error('Virtual album files cannot be deleted.');
            }

            // Get the album and asset from the cache
            const album = await this.getAlbumFromCache(filename, false);
            const asset = await this.getAssetFromCache(filename, false);

            await this.deleteAsset(album, asset);
        }
    }
    async mkdir(path: string): Promise<void> {
        // Only allow creation of folders at level 1 (e.g., "/MyAlbum")
        const cleanedPath = path.replace(/^\/+|\/+$/g, ""); // Remove leading and trailing slashes
        if (cleanedPath.includes("/")) {
            throw new Error("Only top-level folders (albums) can be created.");
        }

        // Create a new album in Immich
        await this.immichRequest({
            method: 'POST',
            endpoint: 'albums',
            data: JSON.stringify({ albumName: cleanedPath }),
            logAction: 'Create album'
        });
    }

    // Find albums and assets
    private async fetchCurrentUser(fallbackUsername: string): Promise<void> {
        try {
            const me = await this.immichRequest({
                method: 'GET',
                endpoint: 'users/me',
                logAction: 'Current user',
                skipResponseLog: true,
            });
            this.currentUser = this.extractCurrentUser(me, fallbackUsername);
        } catch (error) {
            console.warn('Could not fetch current user, falling back to login username.');
            this.currentUser = {
                id: '',
                username: fallbackUsername,
                email: fallbackUsername,
            };
        }
    }
    private async fetchAlbums(): Promise<ImmichAlbum[]> {

        //Parameter "shaerd":
        // - not set: All albums owned by me, also when shared with other users
        // - false: only own albums, that are not shared with other users
        // - true: only shared albums, own and from other users shared with me

        // Fetch albums from Immich API
        const response = await this.immichRequest({
            method: 'GET',
            endpoint: 'albums',
            logAction: 'All own albums',
            skipResponseLog: true,
        });

        //Process and filter albums
        return this.filterAlbums(response);
    }
    private async fetchAlbumsForAssetId(assetId: string): Promise<ImmichAlbum[]> {
        // Check in which albums the asset is used
        const response = await this.immichRequest({
            method: 'GET',
            endpoint: `albums?assetId=${assetId}`,
            logAction: 'Albums for assetId',
            skipResponseLog: true,
        });

        //Process and filter albums
        return this.filterAlbums(response);
    }
    private filterAlbums(response: unknown) {
        if (!Array.isArray(response)) {
            console.warn('Unexpected albums response format, expected array.');
            return [];
        }

        // Map response to ImmichAlbum objects
        const albums: ImmichAlbum[] = response.map((item): ImmichAlbum => this.mapAlbumFromApi(item as ImmichAlbumApiResponse));

        // Filter out albums whose description contains "#nosync"
        let filteredAlbums = albums.filter(album => !hasNoSyncTag(album.description));

        // Filter out albums with empty or invalid names
        filteredAlbums = filteredAlbums.filter(album => isValidFilename(album.albumName));

        // Filter out duplicate album names (case-insensitive)
        const seenNames = new Set<string>();
        filteredAlbums = filteredAlbums.filter(album => {
            const lowerName = album.albumName.toLowerCase();
            if (seenNames.has(lowerName)) return false;
            seenNames.add(lowerName);
            return true;
        });

        //Return filtered albums
        return filteredAlbums;
    }

    private async fetchAssetsForAlbum(album: ImmichAlbum): Promise<void> {
        // Fetch assets
        const response = await this.immichRequest({
            method: 'GET',
            endpoint: `albums/${album.id}`,
            logAction: 'Assets in album',
            skipResponseLog: true,
        });

        this.applyAlbumDetails(album, response);

        // Convert to ImmichAsset
        album.assets = (response.assets ?? []).map((asset: any): ImmichAsset => {

            if (!asset.exifInfo?.fileSizeInByte) {
                console.warn(`Asset ${asset.originalFileName} (${asset.id}) has no exifInfo.fileSizeInByte, using 0 as fallback.`);
            }

            return {
                id: asset.id,
                originalFileName: asset.originalFileName,
                fileCreatedAt: asset.fileCreatedAt,
                fileModifiedAt: asset.fileModifiedAt,
                fileSizeInByte: asset.exifInfo?.fileSizeInByte ?? 0,
                isTrashed: asset.isTrashed,
            }
        });
    }
    private extractPathInfo(filePath: string): { albumName: string; fileName: string | null } {
        // Entfernt führende und doppelte Slashes, z. B. aus "//Pflanzen/..." → "Pflanzen/..."
        const cleanedPath = filePath.replace(/^\/+|\/+$/g, "");

        const parts = cleanedPath.split('/').filter(Boolean); // Entfernt leere Segmente

        if (parts.length === 1) {
            return {
                albumName: parts[0],
                fileName: null,
            };
        } else if (parts.length === 2) {
            return {
                albumName: parts[0],
                fileName: parts[1],
            };
        } else {
            throw new Error(`Ungültiger Pfad: "${filePath}" – Erwartet 1 oder 2 Segmente.`);
        }
    }
    private async getAlbumFromCache(filename: string, refreshCache: boolean): Promise<ImmichAlbum> {
        const album = await this.getAlbumOrNullFromCache(filename, refreshCache);
        if (!album) {
            throw new Error(`Album not found for filename: ${filename}`);
        }

        return album;
    }
    private async getAlbumOrNullFromCache(filename: string, refreshCache: boolean): Promise<ImmichAlbum | null> {
        // If albums are not cached, fetch them
        if (this.albumsCache.length === 0 || refreshCache) {
            this.albumsCache = await this.fetchAlbums();
        }

        // Find the album based on the current directory
        const folderName = this.extractPathInfo(filename).albumName;
        return this.albumsCache.find(a => a.albumName === folderName) || null;
    }
    private async getAssetFromCache(filename: string, refreshAssetsForThisAlbum: boolean): Promise<ImmichAsset> {
        const asset = await this.getAssetOrNullFromCache(filename, refreshAssetsForThisAlbum);
        if (asset) {
            return asset;
        }
        throw new Error(`Asset not found for filename: ${filename}`);
    }
    private async getAssetOrNullFromCache(filename: string, refreshAssetsForThisAlbum: boolean): Promise<ImmichAsset | null> {
        //Get the album from the cache
        const album = await this.getAlbumOrNullFromCache(filename, false);
        if (!album) return null;

        // If the album has no assets, fetch them
        if ((album.assets?.length ?? 0) === 0 || refreshAssetsForThisAlbum) {
            await this.fetchAssetsForAlbum(album);
        }

        // Find the asset in the album based on the original file name
        const assetFileName = this.extractPathInfo(filename).fileName;
        return album.assets?.find(a => a.originalFileName === assetFileName) || null;
    }
    private async deleteAsset(album: ImmichAlbum, asset: ImmichAsset): Promise<void> {
        // Check in which albums the asset is used
        const albumsForAsset = await this.fetchAlbumsForAssetId(asset.id);

        // If the asset is in other albums
        if (albumsForAsset && albumsForAsset.length > 1) {

            // Remove asset from album
            await this.removeAssetFromAlbum(album, asset.id);
        }
        else {
            // Asset is used in only 1 or no album, delete it from Immich
            await this.immichRequest({
                method: 'DELETE',
                endpoint: 'assets',
                data: JSON.stringify({ ids: [asset.id] }),
                logAction: 'Delete asset'
            });
        }
    }
    private async removeAssetFromAlbum(album: ImmichAlbum, assetId: string): Promise<void> {
        // Remove asset from album
        await this.immichRequest({
            method: 'DELETE',
            endpoint: `albums/${album.id}/assets`,
            data: JSON.stringify({ ids: [assetId] }),
            logAction: 'Remove asset from album'
        });
    }

    private isAlbumMetadataFilePath(filePath: string): boolean {
        try {
            const pathInfo = this.extractPathInfo(filePath);
            return isAlbumMetadataFileName(pathInfo.fileName);
        } catch {
            return false;
        }
    }
    private isAlbumBrowserLinkFilePath(filePath: string): boolean {
        try {
            const pathInfo = this.extractPathInfo(filePath);
            return isAlbumBrowserLinkFileName(pathInfo.fileName);
        } catch {
            return false;
        }
    }
    private isVirtualAlbumFile(filePath: string): boolean {
        return this.isAlbumMetadataFilePath(filePath) || this.isAlbumBrowserLinkFilePath(filePath);
    }

    private tmpFileFromString(content: string): tmp.FileResult {
        const tempFile = tmp.fileSync();
        fs.writeFileSync(tempFile.name, content, 'utf8');
        return tempFile;
    }

    private buildAlbumMetadataYaml(album: ImmichAlbum): string {
        return buildAlbumMetadataYaml({
            id: album.id,
            name: album.albumName,
            description: album.description,
            ownerUsername: album.ownerUsername,
            ownerId: album.ownerId,
            createdAt: album.createdAt,
            updatedAt: album.updatedAt,
            sharedUsers: album.albumUsers,
        }, this.isCurrentUserAlbumOwner(album), this.baseUrl);
    }

    private buildAlbumBrowserLink(album: ImmichAlbum): string {
        return buildAlbumBrowserLink(this.baseUrl, album.id);
    }

    private async applyAlbumMetadataFileContent(album: ImmichAlbum, content: string): Promise<void> {
        const metadata = parseAndValidateAlbumMetadataYaml(content);
        const current = buildAlbumMetadataDocument({
            id: album.id,
            name: album.albumName,
            description: album.description,
            ownerUsername: album.ownerUsername,
            ownerId: album.ownerId,
            createdAt: album.createdAt,
            updatedAt: album.updatedAt,
            sharedUsers: album.albumUsers,
        }, this.isCurrentUserAlbumOwner(album), this.baseUrl);

        const changedImmutableFields = getChangedImmutableAlbumMetadataFields(current, metadata);

        if (changedImmutableFields.length > 0) {
            throw new Error(`Blocked save: immutable album.yaml fields were modified (${changedImmutableFields.join(', ')}).`);
        }

        // Only owner may edit metadata
        if (!this.isCurrentUserAlbumOwner(album)) {
            throw new Error('Blocked save: only the album owner can edit album.yaml.');
        }

        // Update album description + #nosync handling
        const newDescription = mergeNoSyncTag(metadata.album.description, metadata.settings.hiddenFromSftp);
        if ((album.description ?? '') !== newDescription) {
            await this.immichRequest({
                method: 'PATCH',
                endpoint: `albums/${album.id}`,
                data: JSON.stringify({ description: newDescription }),
                logAction: 'Update album description/settings',
            });
            album.description = newDescription;
        }

        // Update sharing if changed
        if (!sameSharedUsers(current.sharing.sharedUsers, metadata.sharing.sharedUsers)) {
            await this.updateAlbumSharing(album, metadata.sharing.sharedUsers);
        }

        // Refresh this album from API
        await this.fetchAssetsForAlbum(album);
    }

    private async updateAlbumSharing(album: ImmichAlbum, sharedUsers: AlbumMetadataSharedUser[]): Promise<void> {
        const existingUsers = album.albumUsers ?? [];
        const byUserId = new Map(existingUsers.map(user => [user.userId, user]));
        const byUsername = new Map(existingUsers.map(user => [user.username.toLowerCase(), user]));

        const updatedSharedUsers: Array<{ userId: string; role: string }> = [];
        for (const sharedUser of sharedUsers) {
            const normalizedName = sharedUser.username.trim().toLowerCase();
            const existing = (sharedUser.userId && byUserId.get(sharedUser.userId)) || byUsername.get(normalizedName);

            if (!existing) {
                throw new Error(`Blocked save: shared user '${sharedUser.username}' is not currently shared on this album. Add new users in the Immich UI before editing their role here.`);
            }

            updatedSharedUsers.push({
                userId: existing.userId,
                role: sharedUser.role,
            });
        }

        await this.immichRequest({
            method: 'PUT',
            endpoint: `albums/${album.id}/users`,
            data: JSON.stringify({ albumUsers: updatedSharedUsers }),
            logAction: 'Update album sharing',
        });

        album.albumUsers = updatedSharedUsers.map(user => {
            const existing = byUserId.get(user.userId);
            return {
                userId: user.userId,
                username: existing?.username ?? user.userId,
                role: user.role,
            };
        });
    }

    private isCurrentUserAlbumOwner(album: ImmichAlbum): boolean {
        if (!this.currentUser) {
            return false;
        }

        if (album.ownerId && this.currentUser.id && album.ownerId === this.currentUser.id) {
            return true;
        }

        const currentCandidates = [this.currentUser.username, this.currentUser.email]
            .filter((value): value is string => Boolean(value))
            .map(value => value.toLowerCase());

        const ownerCandidates = [album.ownerUsername, album.ownerEmail]
            .filter((value): value is string => Boolean(value))
            .map(value => value.toLowerCase());

        return ownerCandidates.some(ownerCandidate => currentCandidates.includes(ownerCandidate));
    }

    private getAlbumMtime(album: ImmichAlbum): number {
        const updatedTimestamp = album.updatedAt ? new Date(album.updatedAt).getTime() : NaN;
        if (Number.isFinite(updatedTimestamp) && updatedTimestamp > 0) {
            return Math.floor(updatedTimestamp / 1000);
        }

        const createdTimestamp = album.createdAt ? new Date(album.createdAt).getTime() : NaN;
        if (Number.isFinite(createdTimestamp) && createdTimestamp > 0) {
            return Math.floor(createdTimestamp / 1000);
        }

        console.warn(`Album '${album.albumName}' has invalid timestamps, using current time as mtime fallback.`);
        return Math.floor(Date.now() / 1000);
    }

    private extractCurrentUser(rawUser: unknown, fallbackUsername: string): ImmichUser {
        if (!this.isObject(rawUser)) {
            return {
                id: '',
                username: fallbackUsername,
                email: fallbackUsername,
            };
        }

        const usernameCandidate = this.extractUsername(rawUser) || fallbackUsername;
        return {
            id: String(rawUser.id ?? ''),
            username: usernameCandidate,
            email: String(rawUser.email ?? fallbackUsername),
        };
    }

    private mapAlbumFromApi(item: ImmichAlbumApiResponse): ImmichAlbum {
        const owner = this.isObject(item?.owner) ? item.owner : null;

        return {
            id: String(item.id),
            albumName: String(item.albumName),
            description: String(item.description ?? ''),
            ownerId: owner ? String(owner.id ?? '') : String(item.ownerId ?? ''),
            ownerUsername: owner ? this.extractUsername(owner) : String(item.ownerName ?? item.ownerEmail ?? ''),
            ownerEmail: owner ? String(owner.email ?? '') : String(item.ownerEmail ?? ''),
            createdAt: item.createdAt ? String(item.createdAt) : undefined,
            updatedAt: item.updatedAt ? String(item.updatedAt) : undefined,
            albumUsers: this.mapAlbumUsers(item.albumUsers),
        };
    }

    private applyAlbumDetails(album: ImmichAlbum, details: unknown): void {
        if (!this.isObject(details)) {
            return;
        }

        const owner = this.isObject(details.owner) ? details.owner : null;

        album.description = String(details.description ?? album.description ?? '');
        album.ownerId = owner ? String(owner.id ?? album.ownerId ?? '') : String(details.ownerId ?? album.ownerId ?? '');
        album.ownerUsername = owner ? this.extractUsername(owner) : String(details.ownerName ?? details.ownerEmail ?? album.ownerUsername ?? '');
        album.ownerEmail = owner ? String(owner.email ?? album.ownerEmail ?? '') : String(details.ownerEmail ?? album.ownerEmail ?? '');
        album.createdAt = details.createdAt ? String(details.createdAt) : album.createdAt;
        album.updatedAt = details.updatedAt ? String(details.updatedAt) : album.updatedAt;
        album.albumUsers = this.mapAlbumUsers(details.albumUsers);
    }

    private mapAlbumUsers(rawAlbumUsers: unknown): ImmichAlbumUser[] {
        if (!Array.isArray(rawAlbumUsers)) {
            return [];
        }

        return rawAlbumUsers
            .map((albumUser: unknown): ImmichAlbumUser | null => {
                if (!this.isObject(albumUser)) {
                    return null;
                }

                const userRaw = this.isObject(albumUser.user) ? albumUser.user : albumUser;
                if (!this.isObject(userRaw)) {
                    return null;
                }

                const userId = String(userRaw.id ?? albumUser.userId ?? '').trim();
                const username = this.extractUsername(userRaw);
                if (!userId || !username) {
                    return null;
                }

                return {
                    userId,
                    username,
                    role: String(albumUser.role ?? 'viewer'),
                };
            })
            .filter((entry): entry is ImmichAlbumUser => entry !== null);
    }

    private extractUsername(user: Record<string, unknown>): string {
        return String(user.name ?? user.username ?? user.email ?? user.id ?? '').trim();
    }

    private isObject(value: unknown): value is Record<string, unknown> {
        return typeof value === 'object' && value !== null && !Array.isArray(value);
    }

    // Remove trailing slashes from the Immich host URL
    private readonly baseUrl = config.immichHost.replace(/\/+$/, '');
    private async immichRequest({ method, endpoint, data, logAction, respAsStream = false, skipResponseLog = false }: { method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', endpoint: string, data?: any, logAction: string, respAsStream?: boolean, skipResponseLog?: boolean }): Promise<any> {
        try {
            console.log(`Sending (${logAction}): ${method} /api/${endpoint}`, this.filterLogData(data));

            const isDownload = method === 'GET' && endpoint.startsWith('assets/') && endpoint.endsWith('/original');

            const response = await axios.request({
                method: method,
                url: `${this.baseUrl}/api/${endpoint}`,
                headers: {
                    ...(isDownload ? {} : { 'Accept': 'application/json' }),
                    'User-Agent': 'ImmichSFTP (Linux)',
                    'Authorization': `Bearer ${this.immichAccessToken}`,
                    ...(data instanceof FormData ? data.getHeaders?.() : { 'Content-Type': 'application/json' }),
                },
                data: data ?? undefined,

                // stream = Streaming requested for download
                // arraybuffer = Download requested without streaming
                // json = Default for all other requests
                responseType: respAsStream ? 'stream' : (isDownload ? 'arraybuffer' : 'json'),
            });

            //Todo better implementation of logging
            if (skipResponseLog == true) {
                console.log(`Received (${logAction}):`, response.status, '[Data skipped]');
            }
            else {
                console.log(`Received (${logAction}):`, response.status, this.filterLogData(response.data));
            }
            return response.data;
        } catch (restoreError) {
            if (axios.isAxiosError(restoreError)) {
                console.error(`Axios error (${logAction}):`, restoreError.response?.data || restoreError.message);
            } else {
                console.error(`Unknown error during http request (${logAction}):`, restoreError);
            }
            throw restoreError;
        }
    }

    private filterLogData(data: unknown): unknown {
        // Filter sensitive data from the log
        if (Buffer.isBuffer(data)) {
            return '[Binary Data]'; // Mask the binary data as '[Binary Data]'
        }
        if (data instanceof Blob) {
            return '[Blob]';  // For browsers, you can handle Blobs
        }
        // Hide FormData contents
        if (data instanceof FormData) {
            return '[FormData]';
        }
        // Handle edge cases where the data might be large and contain binary-like strings.
        if (typeof data === 'string' && /[^\x00-\x7F]/.test(data)) {
            return '[Non-ASCII Text]'; // Mask non-ASCII content as non-readable text
        }
        return data; // Return as is if not an object
    }

}



//Data Classes
interface ImmichAlbum {
    id: string;
    albumName: string;
    description: string;
    ownerId?: string;
    ownerUsername?: string;
    ownerEmail?: string;
    createdAt?: string;
    updatedAt?: string;
    albumUsers?: ImmichAlbumUser[];
    assets?: ImmichAsset[];
}

interface ImmichAlbumUser {
    userId: string;
    username: string;
    role: string;
}

interface ImmichUser {
    id: string;
    username: string;
    email?: string;
}

interface ImmichAsset {
    id: string;
    originalFileName: string;
    fileCreatedAt: string;
    fileModifiedAt: string;
    fileSizeInByte: number;
    isTrashed: boolean;
}

interface ImmichAlbumApiResponse {
    id: string;
    albumName: string;
    description?: string;
    owner?: Record<string, unknown>;
    ownerId?: string;
    ownerName?: string;
    ownerEmail?: string;
    createdAt?: string;
    updatedAt?: string;
    albumUsers?: unknown[];
}
