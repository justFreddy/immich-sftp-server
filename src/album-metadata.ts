import YAML from 'yaml';

export const ALBUM_METADATA_FILE_NAME = 'album.yaml';
export const ALBUM_BROWSER_LINK_FILE_NAME = 'immich.url';

const NOSYNC_TAG = '#nosync';
const NOSYNC_TAG_REGEX = /(?:^|\s)#nosync(?:\s|$)/g;

export interface AlbumMetadataSharedUser {
    userId?: string;
    username: string;
    role: string;
}

export interface AlbumMetadataDocument {
    schemaVersion: number;
    album: {
        id: string;
        name: string;
        description: string;
        ownerUsername?: string;
        ownerId?: string;
        createdAt?: string;
        updatedAt?: string;
    };
    sharing: {
        canEditSharedUsers: boolean;
        sharedUsers: AlbumMetadataSharedUser[];
    };
    settings: {
        hiddenFromSftp: boolean;
    };
    links: {
        immichWeb: string;
    };
}

export interface AlbumMetadataAlbumInput {
    id: string;
    name: string;
    description?: string;
    ownerUsername?: string;
    ownerId?: string;
    createdAt?: string;
    updatedAt?: string;
    sharedUsers?: AlbumMetadataSharedUser[];
}

export function isAlbumMetadataFileName(fileName: string | null): boolean {
    return fileName === ALBUM_METADATA_FILE_NAME;
}

export function isAlbumBrowserLinkFileName(fileName: string | null): boolean {
    return fileName === ALBUM_BROWSER_LINK_FILE_NAME;
}

export function buildAlbumMetadataDocument(album: AlbumMetadataAlbumInput, canEditSharedUsers: boolean, baseUrl: string): AlbumMetadataDocument {
    return {
        schemaVersion: 1,
        album: {
            id: album.id,
            name: album.name,
            description: stripNoSyncTag(album.description ?? ''),
            ownerUsername: album.ownerUsername ?? '',
            ownerId: album.ownerId ?? '',
            createdAt: album.createdAt,
            updatedAt: album.updatedAt,
        },
        sharing: {
            canEditSharedUsers,
            sharedUsers: (album.sharedUsers ?? []).map(user => ({
                userId: user.userId,
                username: user.username,
                role: user.role,
            })),
        },
        settings: {
            hiddenFromSftp: hasNoSyncTag(album.description),
        },
        links: {
            immichWeb: `${baseUrl}/albums/${album.id}`,
        },
    };
}

export function buildAlbumMetadataYaml(album: AlbumMetadataAlbumInput, canEditSharedUsers: boolean, baseUrl: string): string {
    return YAML.stringify(buildAlbumMetadataDocument(album, canEditSharedUsers, baseUrl));
}

export function buildAlbumBrowserLink(baseUrl: string, albumId: string): string {
    return `[InternetShortcut]\nURL=${baseUrl}/albums/${albumId}\n`;
}

export function parseAndValidateAlbumMetadataYaml(content: string): AlbumMetadataDocument {
    const parsed = YAML.parse(content);
    if (!isObject(parsed)) {
        throw new Error('Invalid album.yaml: expected a YAML object.');
    }

    return validateAlbumMetadataDocument(parsed);
}

export function getChangedImmutableAlbumMetadataFields(current: AlbumMetadataDocument, next: AlbumMetadataDocument): string[] {
    const changedImmutableFields: string[] = [];
    if (next.schemaVersion !== current.schemaVersion) changedImmutableFields.push('schemaVersion');
    if (next.album.id !== current.album.id) changedImmutableFields.push('album.id');
    if (next.album.name !== current.album.name) changedImmutableFields.push('album.name');
    if (next.album.ownerUsername !== current.album.ownerUsername) changedImmutableFields.push('album.ownerUsername');
    if (next.album.ownerId !== current.album.ownerId) changedImmutableFields.push('album.ownerId');
    if (next.links.immichWeb !== current.links.immichWeb) changedImmutableFields.push('links.immichWeb');
    return changedImmutableFields;
}

export function sameSharedUsers(a: AlbumMetadataSharedUser[], b: AlbumMetadataSharedUser[]): boolean {
    if (a.length !== b.length) {
        return false;
    }

    const normalize = (entries: AlbumMetadataSharedUser[]) => entries
        .map(entry => ({
            userId: (entry.userId ?? '').toLowerCase(),
            username: entry.username.toLowerCase(),
            role: entry.role.toLowerCase(),
        }))
        .sort((left, right) => {
            const byUserId = left.userId.localeCompare(right.userId);
            if (byUserId !== 0) {
                return byUserId;
            }

            const byUsername = left.username.localeCompare(right.username);
            if (byUsername !== 0) {
                return byUsername;
            }

            return left.role.localeCompare(right.role);
        });

    const left = normalize(a);
    const right = normalize(b);
    return left.every((entry, index) =>
        entry.userId === right[index].userId
        && entry.username === right[index].username
        && entry.role === right[index].role
    );
}

export function hasNoSyncTag(description: string | undefined): boolean {
    return (description ?? '').includes(NOSYNC_TAG);
}

export function stripNoSyncTag(description: string): string {
    return description
        .replace(NOSYNC_TAG_REGEX, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

export function mergeNoSyncTag(descriptionText: string, hiddenFromSftp: boolean): string {
    const cleaned = stripNoSyncTag(descriptionText);
    if (!hiddenFromSftp) {
        return cleaned;
    }

    return cleaned ? `${cleaned} ${NOSYNC_TAG}` : NOSYNC_TAG;
}

function validateAlbumMetadataDocument(input: Record<string, unknown>): AlbumMetadataDocument {
    if (!isObject(input.album) || !isObject(input.sharing) || !isObject(input.settings) || !isObject(input.links)) {
        throw new Error('Invalid album.yaml: missing required root sections (album, sharing, settings, links).');
    }

    const sharedUsersInput = Array.isArray(input.sharing.sharedUsers) ? input.sharing.sharedUsers : [];
    const sharedUsers: AlbumMetadataSharedUser[] = sharedUsersInput.map((user, index) => {
        if (!isObject(user)) {
            throw new Error(`Invalid album.yaml: sharing.sharedUsers[${index}] must be an object.`);
        }

        const username = String(user.username ?? '').trim();
        const role = String(user.role ?? '').trim();
        const userId = user.userId == null ? undefined : String(user.userId).trim();

        if (!username) {
            throw new Error(`Invalid album.yaml: sharing.sharedUsers[${index}].username is required.`);
        }
        if (!role) {
            throw new Error(`Invalid album.yaml: sharing.sharedUsers[${index}].role is required.`);
        }

        return { userId, username, role };
    });

    return {
        schemaVersion: Number(input.schemaVersion),
        album: {
            id: String(input.album.id ?? ''),
            name: String(input.album.name ?? ''),
            description: String(input.album.description ?? ''),
            ownerUsername: String(input.album.ownerUsername ?? ''),
            ownerId: String(input.album.ownerId ?? ''),
            createdAt: input.album.createdAt ? String(input.album.createdAt) : undefined,
            updatedAt: input.album.updatedAt ? String(input.album.updatedAt) : undefined,
        },
        sharing: {
            canEditSharedUsers: Boolean(input.sharing.canEditSharedUsers),
            sharedUsers,
        },
        settings: {
            hiddenFromSftp: Boolean(input.settings.hiddenFromSftp),
        },
        links: {
            immichWeb: String(input.links.immichWeb ?? ''),
        },
    };
}

function isObject(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
