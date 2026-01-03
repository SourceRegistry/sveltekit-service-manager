import "../tests/services/index.js" //Make sure this loads first
import type {Handle} from "@sveltejs/kit"
export const handle: Handle = ({event, resolve}) => resolve(event)
