import {Router, type Service, ServiceManager} from "$lib/index.js";

const router = Router();

router.GET("/echo/[type]/[...params]", ({params}) => {
    return new Response(params.params);
})

router.GET("/", () => {
    return new Response("pong");
})

const service = {
    name: "ping",
    route: router,
} satisfies Service<'ping'>;

export type PingService = typeof service;

export default ServiceManager.Load(service, import.meta).finally(() => console.log("[Service]", `[${service.name}]`, 'Loaded'));

