<script>
import {Service} from "$lib/client/index.js";
</script>

<h1>
    Service manager
</h1>

<span>Example services</span>
<ul>
    <li>Ping service: <a href={Service('ping').route("/")}>{Service('ping').route("/")}</a></li>
</ul>
