// See https://svelte.dev/docs/kit/types#app.d.ts
// for information about these interfaces

import type {PingService} from "../tests/services/ping.service.js";

declare global {
    namespace App {
        // interface Error {}
        // interface Locals {}
        // interface PageData {}
        // interface PageState {}
        // interface Platform {}

        interface Services {
            ping: PingService
        }
    }
}

export {};
