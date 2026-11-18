import { Buffer } from "buffer";

interface Size {
	width: number;
	height: number;
}

function pngSize(bytes: Uint8Array): Size | null {
	if (bytes.length < 24 || bytes[0] !== 0x89 || bytes[1] !== 0x50) {
		return null;
	}
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	return { width: view.getUint32(16), height: view.getUint32(20) };
}

function jpegSize(bytes: Uint8Array): Size | null {
	if (bytes[0] !== 0xff || bytes[1] !== 0xd8) {
		return null;
	}
	let offset = 2;
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	while (offset + 9 < bytes.length) {
		if (bytes[offset] !== 0xff) {
			return null;
		}
		const marker = bytes[offset + 1] ?? 0;
		const length = view.getUint16(offset + 2);
		if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
			return { height: view.getUint16(offset + 5), width: view.getUint16(offset + 7) };
		}
		offset += 2 + length;
	}
	return null;
}

export class NativeImage {
	readonly #data: Uint8Array;
	readonly #mime: string;

	constructor(data: Uint8Array = new Uint8Array(0), mime = "image/png") {
		this.#data = data;
		this.#mime = mime;
	}

	isEmpty(): boolean {
		return this.#data.length === 0;
	}

	getSize(): Size {
		return pngSize(this.#data) ?? jpegSize(this.#data) ?? { width: 0, height: 0 };
	}

	getAspectRatio(): number {
		const { width, height } = this.getSize();
		return height ? width / height : 1;
	}

	toPNG(): Buffer {
		return Buffer.from(this.#data);
	}

	toJPEG(): Buffer {
		return Buffer.from(this.#data);
	}

	toBitmap(): Buffer {
		return Buffer.alloc(0);
	}

	getBitmap(): Buffer {
		return Buffer.alloc(0);
	}

	toDataURL(): string {
		return `data:${this.#mime};base64,${Buffer.from(this.#data).toString("base64")}`;
	}

	toBlob(): Blob {
		return new Blob([this.#data.slice()], { type: this.#mime });
	}

	resize(): NativeImage {
		return this;
	}

	crop(): NativeImage {
		return this;
	}

	addRepresentation(): void {}

	getScaleFactors(): number[] {
		return [1];
	}

	setTemplateImage(): void {}

	isTemplateImage(): boolean {
		return false;
	}
}

function fromDataURL(url: string): NativeImage {
	const match = /^data:([^;,]+)?(;base64)?,(.*)$/s.exec(url);
	if (!match) {
		return new NativeImage();
	}
	const data = match[2] ? Buffer.from(match[3] ?? "", "base64") : Buffer.from(decodeURIComponent(match[3] ?? ""));
	return new NativeImage(new Uint8Array(data), match[1] ?? "image/png");
}

export const nativeImage = {
	createEmpty: () => new NativeImage(),
	createFromBuffer: (buffer: Uint8Array) => new NativeImage(new Uint8Array(buffer)),
	createFromDataURL: fromDataURL,
	createFromPath: () => new NativeImage(),
	createFromBitmap: () => new NativeImage(),
	createThumbnailFromPath: async () => new NativeImage(),
};
