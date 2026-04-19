export interface ImmichAlbumUser {
    userId: string;
    username: string;
    role: string;
}

export interface ImmichUser {
    id: string;
    username: string;
    email?: string;
}

export interface ImmichAlbumApiResponse {
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

export interface ImmichAlbumBase {
    id: string;
    albumName: string;
    description: string;
    ownerId?: string;
    ownerUsername?: string;
    ownerEmail?: string;
    createdAt?: string;
    updatedAt?: string;
    albumUsers?: ImmichAlbumUser[];
}

export function isCurrentUserAlbumOwner(album: ImmichAlbumBase, currentUser: ImmichUser | null): boolean {
    if (!currentUser) {
        return false;
    }

    if (album.ownerId && currentUser.id && album.ownerId === currentUser.id) {
        return true;
    }

    const currentCandidates = [currentUser.username, currentUser.email]
        .filter((value): value is string => Boolean(value))
        .map(value => value.toLowerCase());

    const ownerCandidates = [album.ownerUsername, album.ownerEmail]
        .filter((value): value is string => Boolean(value))
        .map(value => value.toLowerCase());

    return ownerCandidates.some(ownerCandidate => currentCandidates.includes(ownerCandidate));
}

export function getAlbumMtime(album: Pick<ImmichAlbumBase, 'albumName' | 'createdAt' | 'updatedAt'>): number {
    const updatedTimestamp = album.updatedAt ? new Date(album.updatedAt).getTime() : NaN;
    if (Number.isFinite(updatedTimestamp) && updatedTimestamp > 0) {
        return Math.floor(updatedTimestamp / 1000);
    }

    const createdTimestamp = album.createdAt ? new Date(album.createdAt).getTime() : NaN;
    if (Number.isFinite(createdTimestamp) && createdTimestamp > 0) {
        return Math.floor(createdTimestamp / 1000);
    }

    console.warn(`Album '${album.albumName}' has missing/invalid createdAt and updatedAt timestamps, using current time as mtime fallback.`);
    return Math.floor(Date.now() / 1000);
}

export function extractCurrentUser(rawUser: unknown, fallbackUsername: string): ImmichUser {
    if (!isObject(rawUser)) {
        return {
            id: '',
            username: fallbackUsername,
            email: fallbackUsername,
        };
    }

    const usernameCandidate = extractUsername(rawUser) || fallbackUsername;
    return {
        id: String(rawUser.id ?? ''),
        username: usernameCandidate,
        email: String(rawUser.email ?? fallbackUsername),
    };
}

export function mapAlbumFromApi(item: ImmichAlbumApiResponse): ImmichAlbumBase {
    const owner = isObject(item?.owner) ? item.owner : null;

    return {
        id: String(item.id),
        albumName: String(item.albumName),
        description: String(item.description ?? ''),
        ownerId: owner ? String(owner.id ?? '') : String(item.ownerId ?? ''),
        ownerUsername: owner ? extractUsername(owner) : String(item.ownerName ?? item.ownerEmail ?? ''),
        ownerEmail: owner ? String(owner.email ?? '') : String(item.ownerEmail ?? ''),
        createdAt: item.createdAt ? String(item.createdAt) : undefined,
        updatedAt: item.updatedAt ? String(item.updatedAt) : undefined,
        albumUsers: mapAlbumUsers(item.albumUsers),
    };
}

export function applyAlbumDetails(album: ImmichAlbumBase, details: unknown): void {
    if (!isObject(details)) {
        return;
    }

    const owner = isObject(details.owner) ? details.owner : null;

    album.description = String(details.description ?? album.description ?? '');
    album.ownerId = owner ? String(owner.id ?? album.ownerId ?? '') : String(details.ownerId ?? album.ownerId ?? '');
    album.ownerUsername = owner ? extractUsername(owner) : String(details.ownerName ?? details.ownerEmail ?? album.ownerUsername ?? '');
    album.ownerEmail = owner ? String(owner.email ?? album.ownerEmail ?? '') : String(details.ownerEmail ?? album.ownerEmail ?? '');
    album.createdAt = details.createdAt ? String(details.createdAt) : album.createdAt;
    album.updatedAt = details.updatedAt ? String(details.updatedAt) : album.updatedAt;
    album.albumUsers = mapAlbumUsers(details.albumUsers);
}

function mapAlbumUsers(rawAlbumUsers: unknown): ImmichAlbumUser[] {
    if (!Array.isArray(rawAlbumUsers)) {
        return [];
    }

    return rawAlbumUsers
        .map((albumUser: unknown): ImmichAlbumUser | null => {
            if (!isObject(albumUser)) {
                return null;
            }

            const userRaw = isObject(albumUser.user) ? albumUser.user : albumUser;
            if (!isObject(userRaw)) {
                return null;
            }

            const userId = String(userRaw.id ?? albumUser.userId ?? '').trim();
            const username = extractUsername(userRaw);
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

function extractUsername(user: Record<string, unknown>): string {
    return String(user.name ?? user.username ?? user.email ?? user.id ?? '').trim();
}

function isObject(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
