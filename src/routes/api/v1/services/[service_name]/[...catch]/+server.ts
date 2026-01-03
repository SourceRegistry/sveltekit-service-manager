import { ServiceManager } from '$lib/server/index.js'; //IMPORTANT Use: @sourceregistry/svelte-service-manager in production.

const { endpoint, access } = ServiceManager.Base();

/**
 * Look for implementation in the $lib/server/services folder
 */
export const { GET, PUT, POST, DELETE, PATCH, HEAD } = endpoint;

/**
 * This the services calls are restricted to only these services
 */
access('ping');
