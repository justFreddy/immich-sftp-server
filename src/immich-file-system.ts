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
const ALBUMS_FOLDER_NAME = 'albums';
const TAGS_FOLDER_NAME = 'tags';
const PEOPLE_FOLDER_NAME = 'people';
const TAG_METADATA_FILE_NAME = 'tag.yaml';
const PERSON_METADATA_FILE_NAME = 'person.yaml';

// JSON-basiertes VirtualFileSystem-Backend
export class ImmichFileSystem implements VirtualFileSystem {

    private immichAccessToken: string = '';
    private albumsCache: ImmichAlbum[] = [];
    private tagsCache: ImmichTag[] = [];
    private peopleCache: ImmichPerson[] = [];
    private uploadQueue: Array<{ filename: string; tmpFile: tmp.FileResult }> = [];
    private currentUser: ImmichUser | null = null;
    private collectionVisibilityCache: { tagsEnabled: boolean; peopleEnabled: boolean } | null = null;

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
        this.currentUser = extractCurrentUser(loginResp.user, username);

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
        this.collectionVisibilityCache = null;
        this.tagsCache = [];
        this.peopleCache = [];
    }

    async setAttributes(filename: string, mtime: number): Promise<void> {
        if (await this.isReadOnlyCollectionPath(filename)) {
            throw new Error(`'${filename}' is read-only.`);
        }

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
                const visibility = await this.getCollectionVisibility();

                const now = Math.floor(Date.now() / 1000);
                const rootEntries: Array<{ name: string; isDir: boolean; size: number; mtime: number }> = [
                    {
                        name: ALBUMS_FOLDER_NAME,
                        isDir: true,
                        size: 0,
                        mtime: now,
                    },
                ];

                if (visibility.tagsEnabled) {
                    rootEntries.push({
                        name: TAGS_FOLDER_NAME,
                        isDir: true,
                        size: 0,
                        mtime: now,
                    });
                }
                if (visibility.peopleEnabled) {
                    rootEntries.push({
                        name: PEOPLE_FOLDER_NAME,
                        isDir: true,
                        size: 0,
                        mtime: now,
                    });
                }
                return rootEntries;
            }

            if (this.isAlbumsPath(currentDir)) {
                const pathInfo = this.extractAlbumPathInfo(currentDir);

                if (!pathInfo.albumName) {
                    // Listing /albums — return list of albums
                    this.albumsCache = await this.fetchAlbums();
                    return this.albumsCache.map((album) => ({
                        name: album.albumName,
                        isDir: true,
                        size: 0,
                        mtime: getAlbumMtime(album),
                    }));
                }

                // Listing /albums/<name> — return album contents
                const album = await this.getAlbumFromCache(currentDir, false);
                await this.fetchAssetsForAlbum(album);

                const files = (album.assets ?? []).map((asset) => ({
                    name: this.getAssetDisplayName(asset, album),
                    isDir: false,
                    size: asset.fileSizeInByte,
                    mtime: this.getAssetMtime(asset),
                }));

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

            if (await this.isTagsPath(currentDir)) {
                const pathInfo = this.extractCollectionPathInfo(currentDir, TAGS_FOLDER_NAME);
                if (pathInfo.fileName) {
                    throw new Error(`Invalid tags path: ${currentDir}`);
                }

                if (!pathInfo.itemName) {
                    this.tagsCache = await this.fetchTags();
                    return this.tagsCache.map((tag) => ({
                        name: tag.displayName,
                        isDir: true,
                        size: 0,
                        mtime: this.getTimestampOrNow(tag.updatedAt),
                    }));
                }

                const tag = await this.getTagFromCache(pathInfo.itemName, true);
                const assets = await this.searchAssetsByMetadata({ tagIds: [tag.id] });
                const nameByAssetId = this.getAssetDisplayNameByAssetId(assets, new Set<string>([TAG_METADATA_FILE_NAME]));
                const files = assets.map((asset) => ({
                    name: nameByAssetId.get(asset.id) ?? asset.originalFileName,
                    isDir: false,
                    size: asset.fileSizeInByte,
                    mtime: this.getAssetMtime(asset),
                }));
                const metadataContent = this.buildTagMetadataYaml(tag);
                files.push({
                    name: TAG_METADATA_FILE_NAME,
                    isDir: false,
                    size: Buffer.byteLength(metadataContent, 'utf8'),
                    mtime: this.getTimestampOrNow(tag.updatedAt),
                });
                return files;
            }

            if (await this.isPeoplePath(currentDir)) {
                const pathInfo = this.extractCollectionPathInfo(currentDir, PEOPLE_FOLDER_NAME);
                if (pathInfo.fileName) {
                    throw new Error(`Invalid people path: ${currentDir}`);
                }

                if (!pathInfo.itemName) {
                    this.peopleCache = await this.fetchPeople();
                    return this.peopleCache.map((person) => ({
                        name: person.displayName,
                        isDir: true,
                        size: 0,
                        mtime: this.getTimestampOrNow(person.updatedAt),
                    }));
                }

                const person = await this.getPersonFromCache(pathInfo.itemName, true);
                const assets = await this.searchAssetsByMetadata({ personIds: [person.id] });
                const nameByAssetId = this.getAssetDisplayNameByAssetId(assets, new Set<string>([PERSON_METADATA_FILE_NAME]));
                const files = assets.map((asset) => ({
                    name: nameByAssetId.get(asset.id) ?? asset.originalFileName,
                    isDir: false,
                    size: asset.fileSizeInByte,
                    mtime: this.getAssetMtime(asset),
                }));
                const metadataContent = this.buildPersonMetadataYaml(person);
                files.push({
                    name: PERSON_METADATA_FILE_NAME,
                    isDir: false,
                    size: Buffer.byteLength(metadataContent, 'utf8'),
                    mtime: this.getTimestampOrNow(person.updatedAt),
                });
                return files;
            }

            // No matching path found
            throw new Error(`Unknown path: ${currentDir}`);
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

        const collectionMetadata = await this.getCollectionMetadataFileContentOrNull(filename, true);
        if (collectionMetadata != null) {
            return this.tmpFileFromString(collectionMetadata);
        }

        const collectionAsset = await this.getCollectionAssetOrNull(filename, true);
        if (collectionAsset) {
            const endpoint = config.assetDownloadSource === 'preview'
                ? `assets/${collectionAsset.id}/thumbnail`
                : `assets/${collectionAsset.id}/original`;

            const responseStream: Readable = await this.immichRequest({
                method: 'GET',
                endpoint,
                logAction: 'Download asset',
                respAsStream: true
            });

            const tmpFile = tmp.fileSync();
            const writeStream = fs.createWriteStream(tmpFile.name);
            await pipeline(responseStream, writeStream);
            return tmpFile;
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
        if (await this.isReadOnlyCollectionPath(filename)) {
            tmpFile.removeCallback();
            throw new Error(`'${filename}' is read-only.`);
        }

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
        if (filename === '/') {
            return {
                isDir: true,
                size: 0,
                mtime: Math.floor(Date.now() / 1000),
            };
        }

        if (await this.isTagsPath(filename)) {
            const pathInfo = this.extractCollectionPathInfo(filename, TAGS_FOLDER_NAME);
            if (!pathInfo.itemName) {
                return {
                    isDir: true,
                    size: 0,
                    mtime: Math.floor(Date.now() / 1000),
                };
            }

            if (!pathInfo.fileName) {
                const tag = await this.getTagOrNullFromCache(pathInfo.itemName, true);
                if (!tag) {
                    return null;
                }
                return {
                    isDir: true,
                    size: 0,
                    mtime: this.getTimestampOrNow(tag.updatedAt),
                };
            }

            if (pathInfo.fileName === TAG_METADATA_FILE_NAME) {
                const tag = await this.getTagOrNullFromCache(pathInfo.itemName, true);
                if (!tag) {
                    return null;
                }
                const metadataContent = this.buildTagMetadataYaml(tag);
                return {
                    isDir: false,
                    size: Buffer.byteLength(metadataContent, 'utf8'),
                    mtime: this.getTimestampOrNow(tag.updatedAt),
                };
            }

            const asset = await this.getCollectionAssetOrNull(filename, true);
            if (!asset) {
                return null;
            }
            return {
                isDir: false,
                size: asset.fileSizeInByte,
                mtime: this.getAssetMtime(asset),
            };
        }

        if (await this.isPeoplePath(filename)) {
            const pathInfo = this.extractCollectionPathInfo(filename, PEOPLE_FOLDER_NAME);
            if (!pathInfo.itemName) {
                return {
                    isDir: true,
                    size: 0,
                    mtime: Math.floor(Date.now() / 1000),
                };
            }

            if (!pathInfo.fileName) {
                const person = await this.getPersonOrNullFromCache(pathInfo.itemName, true);
                if (!person) {
                    return null;
                }
                return {
                    isDir: true,
                    size: 0,
                    mtime: this.getTimestampOrNow(person.updatedAt),
                };
            }

            if (pathInfo.fileName === PERSON_METADATA_FILE_NAME) {
                const person = await this.getPersonOrNullFromCache(pathInfo.itemName, true);
                if (!person) {
                    return null;
                }
                const metadataContent = this.buildPersonMetadataYaml(person);
                return {
                    isDir: false,
                    size: Buffer.byteLength(metadataContent, 'utf8'),
                    mtime: this.getTimestampOrNow(person.updatedAt),
                };
            }

            const asset = await this.getCollectionAssetOrNull(filename, true);
            if (!asset) {
                return null;
            }
            return {
                isDir: false,
                size: asset.fileSizeInByte,
                mtime: this.getAssetMtime(asset),
            };
        }

        if (this.isAlbumsPath(filename)) {
            const pathInfo = this.extractAlbumPathInfo(filename);

            if (!pathInfo.albumName) {
                // /albums root folder
                return {
                    isDir: true,
                    size: 0,
                    mtime: Math.floor(Date.now() / 1000),
                };
            }

            if (!pathInfo.fileName) {
                // /albums/<name>
                const album = await this.getAlbumOrNullFromCache(filename, true);
                if (!album) {
                    return null;
                }
                return {
                    isDir: true,
                    size: 0,
                    mtime: getAlbumMtime(album),
                };
            }

            // /albums/<name>/<file>
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

            const asset = await this.getAssetOrNullFromCache(filename, true);
            if (asset) {
                return {
                    isDir: false,
                    size: asset.fileSizeInByte,
                    mtime: this.getAssetMtime(asset),
                };
            }
            return null;
        }

        return null;
    }
    async rename(oldName: string, newName: string): Promise<void> {
        if (this.isVirtualAlbumFile(oldName) || this.isVirtualAlbumFile(newName)) {
            throw new Error('Renaming virtual album files is not supported.');
        }

        if (await this.isTagsPath(oldName) || await this.isTagsPath(newName)) {
            await this.renameCollectionFolder(oldName, newName, TAGS_FOLDER_NAME);
            return;
        }

        if (await this.isPeoplePath(oldName) || await this.isPeoplePath(newName)) {
            await this.renameCollectionFolder(oldName, newName, PEOPLE_FOLDER_NAME);
            return;
        }

        // Check if the file exists in the upload queue (in-flight upload rename)
        const fileIndex = this.uploadQueue.findIndex(f => f.filename === oldName);
        if (fileIndex !== -1) {
            this.uploadQueue[fileIndex].filename = newName;
            return;
        }

        // Detect album folder rename: /albums/OldName → /albums/NewName
        if (this.isAlbumsPath(oldName) || this.isAlbumsPath(newName)) {
            const oldPathInfo = this.extractAlbumPathInfo(oldName);
            const newPathInfo = this.extractAlbumPathInfo(newName);

            const isAlbumFolderRename = oldPathInfo.albumName && !oldPathInfo.fileName
                && newPathInfo.albumName && !newPathInfo.fileName;
            if (!isAlbumFolderRename) {
                throw new Error(`'${ALBUMS_FOLDER_NAME}' is read-only except for renaming album folders.`);
            }

            const newAlbumName = newPathInfo.albumName as string;
            if (!isValidFilename(newAlbumName)) {
                throw new Error(`Invalid album name: '${newAlbumName}'.`);
            }

            const album = await this.getAlbumOrNullFromCache(oldName, true);
            if (!album) {
                throw new Error(`Album not found: '${oldPathInfo.albumName}'.`);
            }

            await this.immichRequest({
                method: 'PATCH',
                endpoint: `albums/${album.id}`,
                data: JSON.stringify({ albumName: newAlbumName }),
                logAction: 'Rename album',
            });
            this.albumsCache = await this.fetchAlbums();
            return;
        }

        throw new Error("Rename not support for Immich backend. Expect for tmp files (files that have been upload with OPEN, WRITE, CLOSE, but not jet sent to Immich in SETSTAT).");
    }
    async remove(filename: string): Promise<void> {
        if (await this.isReadOnlyCollectionPath(filename)) {
            throw new Error(`'${filename}' is read-only.`);
        }

        if (!this.isAlbumsPath(filename)) {
            throw new Error(`'${filename}' cannot be removed.`);
        }

        const pathInfo = this.extractAlbumPathInfo(filename);

        if (!pathInfo.albumName) {
            throw new Error(`The '${ALBUMS_FOLDER_NAME}' folder itself cannot be removed.`);
        }

        if (!pathInfo.fileName) {
            // Delete album
            const album = await this.getAlbumFromCache(filename, false);
            await this.fetchAssetsForAlbum(album);

            for (const asset of album.assets ?? []) {
                await this.deleteAsset(album, asset);
            }

            await this.immichRequest({
                method: 'DELETE',
                endpoint: `albums/${album.id}`,
                logAction: 'Delete album'
            });
            return;
        }

        // Delete asset
        if (this.isVirtualAlbumFile(filename)) {
            throw new Error('Virtual album files cannot be deleted.');
        }

        const album = await this.getAlbumFromCache(filename, false);
        const asset = await this.getAssetFromCache(filename, false);
        await this.deleteAsset(album, asset);
    }
    async mkdir(dirPath: string): Promise<void> {
        if (await this.isReadOnlyCollectionPath(dirPath)) {
            throw new Error(`'${dirPath}' is read-only.`);
        }

        if (!this.isAlbumsPath(dirPath)) {
            throw new Error("New folders can only be created inside '/albums'.");
        }

        const pathInfo = this.extractAlbumPathInfo(dirPath);
        if (!pathInfo.albumName || pathInfo.fileName !== null) {
            throw new Error("Only album-level folders can be created (e.g. '/albums/MyAlbum').");
        }

        await this.immichRequest({
            method: 'POST',
            endpoint: 'albums',
            data: JSON.stringify({ albumName: pathInfo.albumName }),
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
        album.assets = (response.assets ?? []).map((asset: any): ImmichAsset => this.mapAssetFromApi(asset));
    }

    private mapAssetFromApi(asset: any): ImmichAsset {
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
        };
    }

    private async getCollectionVisibility(): Promise<{ tagsEnabled: boolean; peopleEnabled: boolean }> {
        if (this.collectionVisibilityCache) {
            return this.collectionVisibilityCache;
        }

        let tagsEnabled = config.enableTagsFolderDefault;
        let peopleEnabled = config.enablePeopleFolderDefault;

        try {
            const preferences = await this.immichRequest({
                method: 'GET',
                endpoint: 'users/me/preferences',
                logAction: 'Current user preferences',
                skipResponseLog: true,
            });

            if (typeof preferences?.tags?.enabled === 'boolean') {
                tagsEnabled = preferences.tags.enabled;
            }
            if (typeof preferences?.people?.enabled === 'boolean') {
                peopleEnabled = preferences.people.enabled;
            }
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            console.warn(`Could not fetch user preferences (${errorMessage}), using default collection settings.`);
        }

        this.collectionVisibilityCache = { tagsEnabled, peopleEnabled };
        return this.collectionVisibilityCache;
    }

    private async isTagsPath(filePath: string): Promise<boolean> {
        const visibility = await this.getCollectionVisibility();
        return visibility.tagsEnabled && this.pathStartsWithFolder(filePath, TAGS_FOLDER_NAME);
    }

    private async isPeoplePath(filePath: string): Promise<boolean> {
        const visibility = await this.getCollectionVisibility();
        return visibility.peopleEnabled && this.pathStartsWithFolder(filePath, PEOPLE_FOLDER_NAME);
    }

    private async isReadOnlyCollectionPath(filePath: string): Promise<boolean> {
        return await this.isTagsPath(filePath) || await this.isPeoplePath(filePath);
    }

    private pathStartsWithFolder(filePath: string, folder: string): boolean {
        const parts = this.getPathParts(filePath);
        return parts[0] === folder;
    }

    private getPathParts(filePath: string): string[] {
        return filePath.replace(/^\/+|\/+$/g, '').split('/').filter(Boolean);
    }

    private extractCollectionPathInfo(filePath: string, rootFolderName: string): { itemName: string | null, fileName: string | null } {
        const parts = this.getPathParts(filePath);
        if (parts[0] !== rootFolderName) {
            throw new Error(`Path '${filePath}' is not in '${rootFolderName}'.`);
        }

        if (parts.length === 1) {
            return { itemName: null, fileName: null };
        }
        if (parts.length === 2) {
            return { itemName: parts[1], fileName: null };
        }
        if (parts.length === 3) {
            return { itemName: parts[1], fileName: parts[2] };
        }
        throw new Error(`Invalid path '${filePath}' in '${rootFolderName}' folder.`);
    }

    private normalizeFolderDisplayName(name: string, fallbackPrefix: string, id: string): string {
        const trimmed = name.trim();
        const fallbackName = `${fallbackPrefix}_${id.slice(0, 8)}`;
        const candidate = trimmed === '' ? fallbackName : trimmed;
        const sanitized = candidate.replace(/[\\/:*?"<>|]/g, '_');
        return sanitized.trim() || fallbackName;
    }

    private async fetchTags(): Promise<ImmichTag[]> {
        const response = await this.immichRequest({
            method: 'GET',
            endpoint: 'tags',
            logAction: 'All tags',
            skipResponseLog: true,
        });

        if (!Array.isArray(response)) {
            return [];
        }

        const seenNames = new Set<string>();
        const tags: ImmichTag[] = [];
        for (const tag of response) {
            if (!tag?.id || typeof tag?.id !== 'string') {
                continue;
            }
            const displayName = this.normalizeFolderDisplayName(String(tag.name ?? ''), 'tag', tag.id);
            if (!isValidFilename(displayName)) {
                continue;
            }
            const lowerDisplayName = displayName.toLowerCase();
            if (seenNames.has(lowerDisplayName)) {
                continue;
            }
            seenNames.add(lowerDisplayName);
            tags.push({
                id: tag.id,
                name: String(tag.name ?? ''),
                displayName,
                updatedAt: typeof tag.updatedAt === 'string' ? tag.updatedAt : undefined,
            });
        }
        return tags;
    }

    private async fetchPeople(): Promise<ImmichPerson[]> {
        const people: ImmichPerson[] = [];
        const seenNames = new Set<string>();
        let page = 1;

        while (true) {
            const response = await this.immichRequest({
                method: 'GET',
                endpoint: `people?page=${page}&size=1000&withHidden=false`,
                logAction: 'All people',
                skipResponseLog: true,
            });

            const responsePeople = Array.isArray(response?.people) ? response.people : [];
            for (const person of responsePeople) {
                if (!person?.id || typeof person?.id !== 'string') {
                    continue;
                }
                const displayName = this.normalizeFolderDisplayName(String(person.name ?? ''), 'person', person.id);
                if (!isValidFilename(displayName)) {
                    continue;
                }
                const lowerDisplayName = displayName.toLowerCase();
                if (seenNames.has(lowerDisplayName)) {
                    continue;
                }
                seenNames.add(lowerDisplayName);
                people.push({
                    id: person.id,
                    name: String(person.name ?? ''),
                    displayName,
                    updatedAt: typeof person.updatedAt === 'string' ? person.updatedAt : undefined,
                });
            }

            if (!response?.hasNextPage) {
                break;
            }
            page += 1;
        }

        return people;
    }

    private async searchAssetsByMetadata(query: { tagIds?: string[]; personIds?: string[] }): Promise<ImmichAsset[]> {
        const byAssetId = new Map<string, ImmichAsset>();
        let page = 1;

        while (true) {
            const response = await this.immichRequest({
                method: 'POST',
                endpoint: 'search/metadata',
                data: JSON.stringify({
                    ...query,
                    page,
                    size: 1000,
                    withDeleted: false,
                    withExif: true,
                }),
                logAction: 'Search assets',
                skipResponseLog: true,
            });

            const items = Array.isArray(response?.assets?.items) ? response.assets.items : [];
            for (const item of items) {
                const asset = this.mapAssetFromApi(item);
                byAssetId.set(asset.id, asset);
            }

            const nextPageRaw = response?.assets?.nextPage;
            const nextPage = typeof nextPageRaw === 'string' ? Number.parseInt(nextPageRaw, 10) : Number.NaN;
            if (!Number.isInteger(nextPage) || nextPage <= page || items.length === 0) {
                break;
            }
            page = nextPage;
        }

        return Array.from(byAssetId.values());
    }

    private async getTagOrNullFromCache(displayName: string, refreshCache: boolean): Promise<ImmichTag | null> {
        if (this.tagsCache.length === 0 || refreshCache) {
            this.tagsCache = await this.fetchTags();
        }
        return this.tagsCache.find((tag) => tag.displayName === displayName) ?? null;
    }

    private async getTagFromCache(displayName: string, refreshCache: boolean): Promise<ImmichTag> {
        const tag = await this.getTagOrNullFromCache(displayName, refreshCache);
        if (!tag) {
            throw new Error(`Tag not found: ${displayName}`);
        }
        return tag;
    }

    private async getPersonOrNullFromCache(displayName: string, refreshCache: boolean): Promise<ImmichPerson | null> {
        if (this.peopleCache.length === 0 || refreshCache) {
            this.peopleCache = await this.fetchPeople();
        }
        return this.peopleCache.find((person) => person.displayName === displayName) ?? null;
    }

    private async getPersonFromCache(displayName: string, refreshCache: boolean): Promise<ImmichPerson> {
        const person = await this.getPersonOrNullFromCache(displayName, refreshCache);
        if (!person) {
            throw new Error(`Person not found: ${displayName}`);
        }
        return person;
    }

    private async getCollectionAssetOrNull(filename: string, refreshCollectionAssets: boolean): Promise<ImmichAsset | null> {
        if (await this.isTagsPath(filename)) {
            const pathInfo = this.extractCollectionPathInfo(filename, TAGS_FOLDER_NAME);
            if (!pathInfo.itemName || !pathInfo.fileName) {
                return null;
            }
            if (pathInfo.fileName === TAG_METADATA_FILE_NAME) {
                return null;
            }
            const tag = await this.getTagOrNullFromCache(pathInfo.itemName, refreshCollectionAssets);
            if (!tag) {
                return null;
            }
            const assets = await this.searchAssetsByMetadata({ tagIds: [tag.id] });
            return this.getAssetFromAssetsByDisplayName(pathInfo.fileName, assets, new Set<string>([TAG_METADATA_FILE_NAME]));
        }

        if (await this.isPeoplePath(filename)) {
            const pathInfo = this.extractCollectionPathInfo(filename, PEOPLE_FOLDER_NAME);
            if (!pathInfo.itemName || !pathInfo.fileName) {
                return null;
            }
            if (pathInfo.fileName === PERSON_METADATA_FILE_NAME) {
                return null;
            }
            const person = await this.getPersonOrNullFromCache(pathInfo.itemName, refreshCollectionAssets);
            if (!person) {
                return null;
            }
            const assets = await this.searchAssetsByMetadata({ personIds: [person.id] });
            return this.getAssetFromAssetsByDisplayName(pathInfo.fileName, assets, new Set<string>([PERSON_METADATA_FILE_NAME]));
        }

        return null;
    }

    private async getCollectionMetadataFileContentOrNull(filename: string, refreshCache: boolean): Promise<string | null> {
        if (await this.isTagsPath(filename)) {
            const pathInfo = this.extractCollectionPathInfo(filename, TAGS_FOLDER_NAME);
            if (!pathInfo.itemName || pathInfo.fileName !== TAG_METADATA_FILE_NAME) {
                return null;
            }
            const tag = await this.getTagOrNullFromCache(pathInfo.itemName, refreshCache);
            return tag ? this.buildTagMetadataYaml(tag) : null;
        }

        if (await this.isPeoplePath(filename)) {
            const pathInfo = this.extractCollectionPathInfo(filename, PEOPLE_FOLDER_NAME);
            if (!pathInfo.itemName || pathInfo.fileName !== PERSON_METADATA_FILE_NAME) {
                return null;
            }
            const person = await this.getPersonOrNullFromCache(pathInfo.itemName, refreshCache);
            return person ? this.buildPersonMetadataYaml(person) : null;
        }

        return null;
    }

    private buildTagMetadataYaml(tag: ImmichTag): string {
        return `id: ${JSON.stringify(tag.id)}\nname: ${JSON.stringify(tag.name)}\ndisplayName: ${JSON.stringify(tag.displayName)}\n`;
    }

    private buildPersonMetadataYaml(person: ImmichPerson): string {
        return `id: ${JSON.stringify(person.id)}\nname: ${JSON.stringify(person.name)}\ndisplayName: ${JSON.stringify(person.displayName)}\n`;
    }

    private async renameCollectionFolder(oldName: string, newName: string, rootFolderName: typeof TAGS_FOLDER_NAME | typeof PEOPLE_FOLDER_NAME): Promise<void> {
        const oldPathInfo = this.extractCollectionPathInfo(oldName, rootFolderName);
        const newPathInfo = this.extractCollectionPathInfo(newName, rootFolderName);
        const isFolderRename = oldPathInfo.itemName && !oldPathInfo.fileName && newPathInfo.itemName && !newPathInfo.fileName;
        if (!isFolderRename) {
            throw new Error(`'${rootFolderName}' is read-only except for renaming ${rootFolderName} folders.`);
        }

        const oldDisplayName = oldPathInfo.itemName as string;
        const newDisplayName = newPathInfo.itemName as string;
        if (!isValidFilename(newDisplayName)) {
            throw new Error(`Invalid folder name: '${newDisplayName}'.`);
        }

        if (rootFolderName === TAGS_FOLDER_NAME) {
            const tag = await this.getTagFromCache(oldDisplayName, true);
            const targetTag = await this.getTagOrNullFromCache(newDisplayName, false);
            if (targetTag && targetTag.id !== tag.id) {
                throw new Error(`A tag with name '${newDisplayName}' already exists.`);
            }

            await this.immichRequest({
                method: 'PUT',
                endpoint: `tags/${tag.id}`,
                data: JSON.stringify({ name: newDisplayName }),
                logAction: 'Rename tag',
            });
            this.tagsCache = await this.fetchTags();
            return;
        }

        const person = await this.getPersonFromCache(oldDisplayName, true);
        const targetPerson = await this.getPersonOrNullFromCache(newDisplayName, false);
        if (targetPerson && targetPerson.id !== person.id) {
            throw new Error(`A person with name '${newDisplayName}' already exists.`);
        }

        await this.immichRequest({
            method: 'PUT',
            endpoint: `people/${person.id}`,
            data: JSON.stringify({ name: newDisplayName }),
            logAction: 'Rename person',
        });
        this.peopleCache = await this.fetchPeople();
    }

    private getAssetFromAssetsByDisplayName(displayName: string, assets: ImmichAsset[], reservedNames: Set<string>): ImmichAsset | null {
        const byDisplayName = this.getAssetDisplayNameMap(assets, reservedNames);
        return byDisplayName.get(displayName) ?? null;
    }

    private getTimestampOrNow(value?: string): number {
        const parsed = value ? Date.parse(value) : Number.NaN;
        if (!Number.isFinite(parsed) || parsed <= 0) {
            return Math.floor(Date.now() / 1000);
        }
        return Math.floor(parsed / 1000);
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

        // Extract album name from either /albums/<name>/... or legacy /<name>/...
        let folderName: string;
        try {
            folderName = this.extractAlbumNameFromPath(filename);
        } catch {
            return null;
        }
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
        const assetFileName = this.extractAssetFileNameFromPath(filename);
        if (!assetFileName || !album.assets) {
            return null;
        }

        return this.getAssetDisplayNameMap(album.assets ?? [], new Set<string>([ALBUM_METADATA_FILE_NAME, ALBUM_BROWSER_LINK_FILE_NAME])).get(assetFileName) ?? null;
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

    private isAlbumsPath(filePath: string): boolean {
        return this.pathStartsWithFolder(filePath, ALBUMS_FOLDER_NAME);
    }

    private extractAlbumPathInfo(filePath: string): { albumName: string | null; fileName: string | null } {
        const parts = this.getPathParts(filePath);
        if (parts[0] !== ALBUMS_FOLDER_NAME) {
            throw new Error(`Path '${filePath}' is not in '${ALBUMS_FOLDER_NAME}'.`);
        }
        if (parts.length === 1) return { albumName: null, fileName: null };
        if (parts.length === 2) return { albumName: parts[1], fileName: null };
        if (parts.length === 3) return { albumName: parts[1], fileName: parts[2] };
        throw new Error(`Invalid album path '${filePath}'.`);
    }

    private extractAlbumNameFromPath(filePath: string): string {
        if (this.isAlbumsPath(filePath)) {
            const albumName = this.extractAlbumPathInfo(filePath).albumName;
            if (!albumName) {
                throw new Error(`Path '${filePath}' does not contain an album name.`);
            }
            return albumName;
        }
        return this.extractPathInfo(filePath).albumName;
    }

    private extractAssetFileNameFromPath(filePath: string): string | null {
        if (this.isAlbumsPath(filePath)) {
            return this.extractAlbumPathInfo(filePath).fileName;
        }
        return this.extractPathInfo(filePath).fileName;
    }

    private isAlbumMetadataFilePath(filePath: string): boolean {
        try {
            return isAlbumMetadataFileName(this.extractAssetFileNameFromPath(filePath));
        } catch {
            return false;
        }
    }
    private isAlbumBrowserLinkFilePath(filePath: string): boolean {
        try {
            return isAlbumBrowserLinkFileName(this.extractAssetFileNameFromPath(filePath));
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

    // Remove trailing slashes from the Immich host URL
    private readonly baseUrl = config.immichHost.replace(/\/+$/, '');
    private async immichRequest({ method, endpoint, data, logAction, respAsStream = false, skipResponseLog = false }: { method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', endpoint: string, data?: any, logAction: string, respAsStream?: boolean, skipResponseLog?: boolean }): Promise<any> {
        try {
            console.log(`Sending (${logAction}): ${method} /api/${endpoint}`, this.filterLogData(data));

            const isDownload = method === 'GET' && endpoint.startsWith('assets/') && (endpoint.endsWith('/original') || endpoint.endsWith('/thumbnail'));

            const response = await axios.request({
                method: method,
                url: `${this.baseUrl}/api/${endpoint}`,
                headers: {
                    ...(isDownload ? {} : { 'Accept': 'application/json' }),
                    'User-Agent': 'ImmichNetworkStorage (Linux)',
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
        return this.getAssetDisplayNameByAssetId(album.assets ?? [], new Set<string>([ALBUM_METADATA_FILE_NAME, ALBUM_BROWSER_LINK_FILE_NAME])).get(asset.id) ?? asset.originalFileName;
    }

    private getAssetDisplayNameMap(assets: ImmichAsset[], reservedNames: Set<string>): Map<string, ImmichAsset> {
        const byDisplayName = new Map<string, ImmichAsset>();
        const usedNames = new Set<string>(reservedNames);

        for (const asset of assets) {
            const preferredName = this.buildPreferredAssetName(asset);
            const uniqueName = this.ensureUniqueAssetName(preferredName, asset, usedNames);
            usedNames.add(uniqueName);
            byDisplayName.set(uniqueName, asset);
        }
        return byDisplayName;
    }

    private getAssetDisplayNameByAssetId(assets: ImmichAsset[], reservedNames: Set<string>): Map<string, string> {
        const byAssetId = new Map<string, string>();
        for (const [displayName, asset] of this.getAssetDisplayNameMap(assets, reservedNames).entries()) {
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

interface ImmichTag {
    id: string;
    name: string;
    displayName: string;
    updatedAt?: string;
}

interface ImmichPerson {
    id: string;
    name: string;
    displayName: string;
    updatedAt?: string;
}
