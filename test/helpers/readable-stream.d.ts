// Node-side typing for "readable-stream" (its API mirrors node:stream). The browser build uses src/types/shims.d.ts.
declare module "readable-stream" {
	import { Duplex, finished, PassThrough, pipeline, Readable, Stream, Transform, Writable } from "node:stream";

	export { Duplex, finished, PassThrough, pipeline, Readable, Stream, Transform, Writable };
}
