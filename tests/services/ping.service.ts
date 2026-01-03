import {Router, ServiceManager} from "$lib/index.js";

const router = Router();

router.GET("/echo/[type]/[...params]", ({params}) => {
    return new Response(params.params);
})

router.GET("/ping", () => {
    return new Response("pong");
})

const service = {
    name: "test",
    route: router
} as const;

export type PingService = typeof service;

export default ServiceManager.Load(service).finally(() => console.log("[Service]", `[${service.name}]`, 'Loaded'));

