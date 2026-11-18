declare module "@mercuryworkshop/wisp-js/server" {
	import type { IncomingMessage } from "node:http";
	import type { Duplex } from "node:stream";

	export const server: {
		routeRequest(request: IncomingMessage, socket: Duplex, head: Buffer, options?: Record<string, unknown>): void;
		options: {
			hostname_blacklist: RegExp[] | null;
			hostname_whitelist: RegExp[] | null;
			port_blacklist: Array<number | [number, number]> | null;
			port_whitelist: Array<number | [number, number]> | null;
			allow_direct_ip: boolean;
			allow_private_ips: boolean;
			allow_loopback_ips: boolean;
			allow_udp_streams: boolean;
			allow_tcp_streams: boolean;
			stream_limit_per_host: number;
			stream_limit_total: number;
			parse_real_ip: boolean;
			parse_real_ip_from: string[];
			wisp_motd: string | null;
		};
	};

	export const logging: {
		DEBUG: number;
		INFO: number;
		WARN: number;
		ERROR: number;
		NONE: number;
		set_level(level: number): void;
	};
}
