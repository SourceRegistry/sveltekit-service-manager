import "$lib/server/services/index.js"
import type {Handle} from "@sveltejs/kit";

export const handle: Handle = ({event, resolve}) => resolve(event)
