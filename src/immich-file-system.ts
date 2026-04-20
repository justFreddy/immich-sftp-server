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
import path from 'path';
import {
    ALBUM_METADATA_FILE_NAME,
    ALBUM_BROWSER_LINK_FILE_NAME,
    hasNoSyncTag,
    isAlbumBrowserLinkFileName,
    isAlbumMetadataFileName
} from './album-metadata';
import {
    applyAlbumDetails,
    extractCurrentUser,
    getAlbumMtime,
    ImmichAlbumApiResponse,
    ImmichAlbumBase,
    ImmichAlbumUser,
    ImmichUser,
    mapAlbumFromApi
} from './immich-album-helpers';
import {
    applyAlbumMetadataFileContent,
    buildAlbumBrowserLinkForAlbum,
    buildAlbumMetadataYamlForAlbum
} from './immich-album-virtual-file-service';

const DEFAULT_ASSET_BASE_NAME = 'asset';

// JSON-basiertes VirtualFileSystem-Backend
export class ImmichFileSystem implements VirtualFileSystem {

    private immichAccessToken: string = '';
    private authMode: 'bearer' | 'api-key' = 'bearer';
    private shouldLogoutSession = false;
    private albumsCache: ImmichAlbum[] = [];
    private uploadQueue: Array<{ filename: string; tmpFile: tmp.FileResult }> = [];
    private currentUser: ImmichUser | null = null;

    async login(username: string, password: string): Promise<void> {
        const trimmedUsername = username.trim();
        const trimmedPassword = password.trim();

        if (trimmedPassword === '' || !this.looksLikeEmail(trimmedUsername)) {
            await this.loginWithToken(trimmedUsername);
            return;
        }

        const loginResp = await this.immichRequest({
            method: 'POST',
            endpoint: 'auth/login',
            data: JSON.stringify({
                email: trimmedUsername,
                password: trimmedPassword,
            }),
            logAction: 'Login'
        });

        // Store the access token
        this.immichAccessToken = loginResp.accessToken;
        this.authMode = 'bearer';
        this.shouldLogoutSession = true;

        // Try to get current user from login response first
        this.currentUser = extractCurrentUser(loginResp.user, trimmedUsername);

        // Fallback to users/me endpoint
        if (!this.currentUser?.id || !this.currentUser?.username) {
            await this.fetchCurrentUser(trimmedUsername);
        }
    }
    async logout(): Promise<void> {
        if (this.shouldLogoutSession) {
            await this.immichRequest({
                method: 'POST',
                endpoint: 'auth/logout',
                logAction: 'Logout'
            });
        }
        this.immichAccessToken = '';
        this.shouldLogoutSession = false;
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
            data.append('deviceId', 'immich-network-storage');
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
                    mtime: getAlbumMtime(album),
                }));
            }
            else {
                // Get album and fetch assets
                const album = await this.getAlbumFromCache(currentDir, false);
                await this.fetchAssetsForAlbum(album);

                // Map assets to the expected format
                const files = (album.assets ?? []).map((asset) => ({
                    name: this.getAssetDisplayName(asset, album),
                    isDir: false,
                    size: asset.fileSizeInByte,
                    mtime: this.getAssetMtime(asset),
                }));

                // Add virtual album metadata/link files
                const metadataContent = buildAlbumMetadataYamlForAlbum(album, this.currentUser, this.baseUrl);
                const linkContent = buildAlbumBrowserLinkForAlbum(album, this.baseUrl);

                files.push({
                    name: ALBUM_METADATA_FILE_NAME,
                    isDir: false,
                    size: Buffer.byteLength(metadataContent, 'utf8'),
                    mtime: getAlbumMtime(album),
                });
                files.push({
                    name: ALBUM_BROWSER_LINK_FILE_NAME,
                    isDir: false,
                    size: Buffer.byteLength(linkContent, 'utf8'),
                    mtime: getAlbumMtime(album),
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
            return this.tmpFileFromString(buildAlbumMetadataYamlForAlbum(album, this.currentUser, this.baseUrl));
        }

        if (this.isAlbumBrowserLinkFilePath(filename)) {
            const album = await this.getAlbumFromCache(filename, false);
            await this.fetchAssetsForAlbum(album);
            return this.tmpFileFromString(buildAlbumBrowserLinkForAlbum(album, this.baseUrl));
        }

        //todo refactor this: Stream not Buffer, Check and refresh cache

        // Get the asset from the cache
        const asset = await this.getAssetFromCache(filename, false);

        // Fetch the original file as a buffer
        const endpoint = config.assetDownloadSource === 'preview'
            ? `assets/${asset.id}/thumbnail`
            : `assets/${asset.id}/original`;

        const responseStream: Readable = await this.immichRequest({
            method: 'GET',
            endpoint,
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
            await applyAlbumMetadataFileContent({
                album,
                content,
                currentUser: this.currentUser,
                baseUrl: this.baseUrl,
                immichRequest: (request) => this.immichRequest(request),
                refreshAlbumAssets: (targetAlbum) => this.fetchAssetsForAlbum(targetAlbum),
            });
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
                    mtime: getAlbumMtime(album),
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
                    const metadata = buildAlbumMetadataYamlForAlbum(album, this.currentUser, this.baseUrl);
                    return {
                        isDir: false,
                        size: Buffer.byteLength(metadata, 'utf8'),
                        mtime: getAlbumMtime(album),
                    };
                }

                const link = buildAlbumBrowserLinkForAlbum(album, this.baseUrl);
                return {
                    isDir: false,
                    size: Buffer.byteLength(link, 'utf8'),
                    mtime: getAlbumMtime(album),
                };
            }

            // It's a file (asset)
            const asset = await this.getAssetOrNullFromCache(filename, true);
            if (asset) {
                return {
                    isDir: false,
                    size: asset.fileSizeInByte,
                    mtime: this.getAssetMtime(asset),
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
            this.currentUser = extractCurrentUser(me, fallbackUsername);
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            console.warn(`Could not fetch current user (${errorMessage}), falling back to login username.`);
            this.currentUser = {
                id: '',
                username: fallbackUsername,
                email: fallbackUsername,
            };
        }
    }
    private async fetchAlbums(): Promise<ImmichAlbum[]> {
        const [ownAlbumsResponse, sharedAlbumsResponse] = await Promise.all([
            this.immichRequest({
                method: 'GET',
                endpoint: 'albums',
                logAction: 'All own albums',
                skipResponseLog: true,
            }),
            this.immichRequest({
                method: 'GET',
                endpoint: 'albums?shared=true',
                logAction: 'All shared albums',
                skipResponseLog: true,
            }),
        ]);

        const ownAlbums = Array.isArray(ownAlbumsResponse) ? ownAlbumsResponse : [];
        const sharedAlbums = Array.isArray(sharedAlbumsResponse) ? sharedAlbumsResponse : [];
        const combinedByAlbumId = new Map<string, Record<string, unknown>>();
        const isObjectWithId = (value: unknown): value is Record<string, unknown> & { id: unknown } =>
            typeof value === 'object' && value !== null && !Array.isArray(value) && 'id' in value;

        for (const album of [...ownAlbums, ...sharedAlbums]) {
            if (isObjectWithId(album)) {
                combinedByAlbumId.set(String(album.id), album);
            }
        }

        return this.filterAlbums(Array.from(combinedByAlbumId.values()));
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
            console.warn(`Unexpected albums response format: expected array but got ${typeof response}.`);
            return [];
        }

        // Map response to ImmichAlbum objects
        const albums: ImmichAlbum[] = response.map((item): ImmichAlbum => mapAlbumFromApi(item as ImmichAlbumApiResponse));

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

        applyAlbumDetails(album, response);

        // Convert to ImmichAsset
        album.assets = (response.assets ?? []).map((asset: any): ImmichAsset => {

            if (!asset.exifInfo?.fileSizeInByte) {
                console.warn(`Asset ${asset.originalFileName} (${asset.id}) has no exifInfo.fileSizeInByte, using 0 as fallback.`);
            }
            return {
                id: asset.id,
                originalFileName: asset.originalFileName,
                createdAt: asset.createdAt,
                updatedAt: asset.updatedAt,
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

        // Find the asset in the album based on the configured visible file name
        const assetFileName = this.extractPathInfo(filename).fileName;
        if (!assetFileName || !album.assets) {
            return null;
        }

        return this.getAssetDisplayNameMap(album).get(assetFileName) ?? null;
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

    private looksLikeEmail(value: string): boolean {
        return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
    }

    private async loginWithToken(token: string): Promise<void> {
        if (!token) {
            throw new Error('Token login requires a non-empty token as username.');
        }

        this.immichAccessToken = token;
        this.shouldLogoutSession = false;

        this.authMode = 'bearer';
        try {
            const me = await this.immichRequest({
                method: 'GET',
                endpoint: 'users/me',
                logAction: 'Current user (token)',
                skipResponseLog: true,
            });
            this.currentUser = extractCurrentUser(me, 'token');
            return;
        } catch {
            // Fall through to API key mode
        }

        this.authMode = 'api-key';
        const me = await this.immichRequest({
            method: 'GET',
            endpoint: 'users/me',
            logAction: 'Current user (api key)',
            skipResponseLog: true,
        });
        this.currentUser = extractCurrentUser(me, 'token');
    }

    // Remove trailing slashes from the Immich host URL
    private readonly baseUrl = config.immichHost.replace(/\/+$/, '');
    private async immichRequest({ method, endpoint, data, logAction, respAsStream = false, skipResponseLog = false }: { method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', endpoint: string, data?: any, logAction: string, respAsStream?: boolean, skipResponseLog?: boolean }): Promise<any> {
        try {
            const isLoginEndpoint = endpoint === 'auth/login';
            const logData = isLoginEndpoint ? '[Sensitive payload redacted]' : this.filterLogData(data);
            console.log(`Sending (${logAction}): ${method} /api/${endpoint}`, logData);

            const isDownload = method === 'GET' && endpoint.startsWith('assets/') && (endpoint.endsWith('/original') || endpoint.endsWith('/thumbnail'));

            const response = await axios.request({
                method: method,
                url: `${this.baseUrl}/api/${endpoint}`,
                headers: {
                    ...(isDownload ? {} : { 'Accept': 'application/json' }),
                    'User-Agent': 'ImmichNetworkStorage (Linux)',
                    ...(this.authMode === 'api-key'
                        ? { 'x-api-key': this.immichAccessToken }
                        : { 'Authorization': `Bearer ${this.immichAccessToken}` }),
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
        if (typeof data === 'string') {
            try {
                const parsed = JSON.parse(data);
                return this.redactSensitiveFields(parsed);
            } catch {
                // Keep non-JSON string as-is.
            }
        }
        if (typeof data === 'object' && data !== null) {
            return this.redactSensitiveFields(data);
        }
        // Handle edge cases where the data might be large and contain binary-like strings.
        if (typeof data === 'string' && /[^\x00-\x7F]/.test(data)) {
            return '[Non-ASCII Text]'; // Mask non-ASCII content as non-readable text
        }
        return data; // Return as is if not an object
    }

    private redactSensitiveFields(data: unknown): unknown {
        const sensitiveKeys = new Set(['password', 'token', 'accessToken', 'authorization', 'x-api-key', 'apiKey']);

        if (Array.isArray(data)) {
            return data.map(item => this.redactSensitiveFields(item));
        }

        if (typeof data !== 'object' || data === null) {
            return data;
        }

        const redacted: Record<string, unknown> = {};
        for (const [key, value] of Object.entries(data)) {
            if (sensitiveKeys.has(key)) {
                redacted[key] = '[REDACTED]';
                continue;
            }
            redacted[key] = this.redactSensitiveFields(value);
        }
        return redacted;
    }

    private getAssetMtime(asset: ImmichAsset): number {
        // Prefer Immich server-maintained timestamps first, then fall back to uploaded file timestamps.
        const candidates = [asset.updatedAt, asset.createdAt, asset.fileModifiedAt, asset.fileCreatedAt];
        for (const value of candidates) {
            const timestamp = value ? new Date(value).getTime() : NaN;
            if (Number.isFinite(timestamp) && timestamp > 0) {
                return Math.floor(timestamp / 1000);
            }
        }

        console.warn(`Asset '${asset.originalFileName}' (ID: ${asset.id}) has missing/invalid timestamps, using current time fallback.`);
        return Math.floor(Date.now() / 1000);
    }

    private getAssetDisplayName(asset: ImmichAsset, album: ImmichAlbum): string {
        return this.getAssetDisplayNameByAssetId(album).get(asset.id) ?? asset.originalFileName;
    }

    private getAssetDisplayNameMap(album: ImmichAlbum): Map<string, ImmichAsset> {
        const byDisplayName = new Map<string, ImmichAsset>();
        const usedNames = new Set<string>([ALBUM_METADATA_FILE_NAME, ALBUM_BROWSER_LINK_FILE_NAME]);

        for (const asset of album.assets ?? []) {
            const preferredName = this.buildPreferredAssetName(asset);
            const uniqueName = this.ensureUniqueAssetName(preferredName, asset, usedNames);
            usedNames.add(uniqueName);
            byDisplayName.set(uniqueName, asset);
        }
        return byDisplayName;
    }

    private getAssetDisplayNameByAssetId(album: ImmichAlbum): Map<string, string> {
        const byAssetId = new Map<string, string>();
        for (const [displayName, asset] of this.getAssetDisplayNameMap(album).entries()) {
            byAssetId.set(asset.id, displayName);
        }
        return byAssetId;
    }

    private buildPreferredAssetName(asset: ImmichAsset): string {
        const extension = path.extname(asset.originalFileName);
        const timestamp = this.getAssetMtime(asset);
        const dt = DateTime.fromSeconds(timestamp, { zone: config.TZ });
        const formattedTimestamp = `${dt.toFormat('yyyyLLdd_HHmmss')}${String(dt.millisecond).padStart(3, '0')}`;
        const shortId = asset.id.slice(0, 8);

        switch (config.assetFileNamePattern) {
            case 'assetUuid':
                return `${asset.id}${extension}`;
            case 'shortUuid':
                return `img_${shortId}${extension}`;
            case 'date':
                return `${formattedTimestamp}${extension}`;
            case 'dateUuid':
                return `${formattedTimestamp}_${shortId}${extension}`;
            case 'original':
            default:
                return asset.originalFileName;
        }
    }

    private ensureUniqueAssetName(preferredName: string, asset: ImmichAsset, usedNames: Set<string>): string {
        if (!usedNames.has(preferredName)) {
            return preferredName;
        }

        const parsed = path.parse(preferredName);
        const shortId = asset.id.slice(0, 8);
        const base = parsed.name || DEFAULT_ASSET_BASE_NAME;
        const ext = parsed.ext || path.extname(asset.originalFileName);

        let candidate = `${base}__${shortId}${ext}`;
        let counter = 2;
        while (usedNames.has(candidate)) {
            candidate = `${base}__${shortId}_${counter}${ext}`;
            counter += 1;
        }
        return candidate;
    }

}



//Data Classes
interface ImmichAlbum extends ImmichAlbumBase {
    assets?: ImmichAsset[];
}

interface ImmichAsset {
    id: string;
    originalFileName: string;
    createdAt?: string;
    updatedAt?: string;
    fileCreatedAt: string;
    fileModifiedAt: string;
    fileSizeInByte: number;
    isTrashed: boolean;
}
