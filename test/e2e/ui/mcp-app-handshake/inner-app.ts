// Keep the guest unmodified and use its default parent transport to detect self-echo.
import { App } from "@modelcontextprotocol/ext-apps";

console.log(`E2E_INNER PARENT_IS_SELF:${window.parent === window}`);

const app = new App({ name: "e2e-inner-app", version: "1.0.0" }, {});

app
  .connect()
  .then(() => console.log("E2E_INNER INNER_CONNECTED"))
  .catch((err: unknown) => console.log(`E2E_INNER INNER_CONNECT_FAILED:${String(err)}`));
