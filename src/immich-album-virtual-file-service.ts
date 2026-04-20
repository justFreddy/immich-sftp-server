import {
    AlbumMetadataSharedUser,
    buildAlbumBrowserLink,
    buildAlbumMetadataDocument,
    buildAlbumMetadataYaml,
    getChangedImmutableAlbumMetadataFields,
    mergeNoSyncTag,
    parseAndValidateAlbumMetadataYaml,
    sameSharedUsers
} from './album-metadata';
import {
    ImmichAlbumBase,
    ImmichAlbumUser,
    ImmichUser,
    isCurrentUserAlbumOwner
} from './immich-album-helpers';

export interface AlbumVirtualFileAlbum extends ImmichAlbumBase {
    albumUsers?: ImmichAlbumUser[];
}

type ImmichRequestMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

interface ImmichRequestArgs {
    method: ImmichRequestMethod;
    endpoint: string;
    data?: any;
    logAction: string;
    respAsStream?: boolean;
    skipResponseLog?: boolean;
}

type ImmichRequestFn = (args: ImmichRequestArgs) => Promise<any>;
type RefreshAlbumAssetsFn = (album: AlbumVirtualFileAlbum) => Promise<void>;

function buildAlbumDocument(album: AlbumVirtualFileAlbum, currentUser: ImmichUser | null, baseUrl: string) {
    return buildAlbumMetadataDocument({
        id: album.id,
        name: album.albumName,
        description: album.description,
        ownerUsername: album.ownerUsername,
        ownerId: album.ownerId,
        createdAt: album.createdAt,
        updatedAt: album.updatedAt,
        sharedUsers: album.albumUsers,
    }, isCurrentUserAlbumOwner(album, currentUser), baseUrl);
}

export function buildAlbumMetadataYamlForAlbum(album: AlbumVirtualFileAlbum, currentUser: ImmichUser | null, baseUrl: string): string {
    return buildAlbumMetadataYaml({
        id: album.id,
        name: album.albumName,
        description: album.description,
        ownerUsername: album.ownerUsername,
        ownerId: album.ownerId,
        createdAt: album.createdAt,
        updatedAt: album.updatedAt,
        sharedUsers: album.albumUsers,
    }, isCurrentUserAlbumOwner(album, currentUser), baseUrl);
}

export function buildAlbumBrowserLinkForAlbum(album: AlbumVirtualFileAlbum, baseUrl: string): string {
    return buildAlbumBrowserLink(baseUrl, album.id);
}

export async function applyAlbumMetadataFileContent({
    album,
    content,
    currentUser,
    baseUrl,
    immichRequest,
    refreshAlbumAssets,
}: {
    album: AlbumVirtualFileAlbum;
    content: string;
    currentUser: ImmichUser | null;
    baseUrl: string;
    immichRequest: ImmichRequestFn;
    refreshAlbumAssets: RefreshAlbumAssetsFn;
}): Promise<void> {
    const metadata = parseAndValidateAlbumMetadataYaml(content);
    const current = buildAlbumDocument(album, currentUser, baseUrl);

    const changedImmutableFields = getChangedImmutableAlbumMetadataFields(current, metadata);
    if (changedImmutableFields.length > 0) {
        throw new Error(`Blocked save: immutable album.yaml fields were modified (${changedImmutableFields.join(', ')}).`);
    }

    if (!isCurrentUserAlbumOwner(album, currentUser)) {
        throw new Error('Blocked save: only the album owner can edit album.yaml.');
    }

    const newAlbumName = metadata.album.name.trim();
    if (newAlbumName && newAlbumName !== album.albumName) {
        await immichRequest({
            method: 'PATCH',
            endpoint: `albums/${album.id}`,
            data: JSON.stringify({ albumName: newAlbumName }),
            logAction: 'Rename album via album.yaml',
        });
        album.albumName = newAlbumName;
    }

    const newDescription = mergeNoSyncTag(metadata.album.description, metadata.settings.hidden);
    if ((album.description ?? '') !== newDescription) {
        await immichRequest({
            method: 'PATCH',
            endpoint: `albums/${album.id}`,
            data: JSON.stringify({ description: newDescription }),
            logAction: 'Update album description/settings',
        });
        album.description = newDescription;
    }

    if (!sameSharedUsers(current.sharing.sharedUsers, metadata.sharing.sharedUsers)) {
        await updateAlbumSharing(immichRequest, album, metadata.sharing.sharedUsers);
    }

    await refreshAlbumAssets(album);
}

async function updateAlbumSharing(immichRequest: ImmichRequestFn, album: AlbumVirtualFileAlbum, sharedUsers: AlbumMetadataSharedUser[]): Promise<void> {
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

    await immichRequest({
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
