/** [mtimeMs, ctimeMs, birthtimeMs, mode, persistedAt?] */
export type MetaRecord = [number, number, number, number, number?];

export interface MetaSnapshot {
	entries: Map<string, MetaRecord>;
	symlinks: Map<string, string>;
}

interface MetaFileV1 {
	v: 1;
	m: Record<string, MetaRecord>;
	l: Record<string, string>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isMetaRecord(value: unknown): value is MetaRecord {
	return (
		Array.isArray(value) &&
		value.length >= 4 &&
		value.length <= 5 &&
		value.every((item) => typeof item === "number" && Number.isFinite(item))
	);
}

export function parseMeta(text: string | null): MetaSnapshot {
	const snapshot: MetaSnapshot = { entries: new Map(), symlinks: new Map() };
	if (!text) {
		return snapshot;
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		return snapshot;
	}
	if (!isRecord(parsed) || parsed.v !== 1) {
		return snapshot;
	}
	if (isRecord(parsed.m)) {
		for (const [path, record] of Object.entries(parsed.m)) {
			if (path.startsWith("/") && isMetaRecord(record)) {
				snapshot.entries.set(path, record);
			}
		}
	}
	if (isRecord(parsed.l)) {
		for (const [path, target] of Object.entries(parsed.l)) {
			if (path.startsWith("/") && typeof target === "string") {
				snapshot.symlinks.set(path, target);
			}
		}
	}
	return snapshot;
}

export function serializeMeta(entries: Record<string, MetaRecord>, symlinks: Record<string, string>): string {
	const file: MetaFileV1 = { v: 1, m: entries, l: symlinks };
	return JSON.stringify(file);
}
