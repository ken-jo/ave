import { app, BrowserWindow, clipboard, shell } from "electron";
import { configureE2eWindowPolicy } from "../../../src/main/e2e-window-policy.js";
import { createDeviceCodePresentation } from "../../../src/main/device-code-dialog.js";

configureE2eWindowPolicy();
const userData = process.env.AVE_DEVICE_DIALOG_USER_DATA;
if (!userData) throw new Error("Device dialog fixture requires an isolated data directory");
app.setPath("userData", userData);
void app.whenReady().then(async () => {
  const parent = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } });
  await parent.loadURL("data:text/html,<title>Device sign-in owner</title>");
  const controller = new AbortController();
  const state = { copied: [] as string[], opened: [] as string[], canceled: false, ready: false };
  clipboard.writeText = (value) => { state.copied.push(value); };
  shell.openExternal = async (url) => { state.opened.push(url); };
  controller.signal.addEventListener("abort", () => { state.canceled = true; });
  const close = await createDeviceCodePresentation(() => parent).show({
    userCode: "ABCD-EFGH", verificationUri: "https://auth.example.test/verify",
    verificationUriComplete: "https://auth.example.test/verify?user_code=ABCD-EFGH", expiresAt: Date.now() + 120_000,
  }, controller);
  state.ready = true;
  Object.assign(globalThis, { deviceCodeDialogFixture: { state, close } });

}).catch((error) => { console.error(error); app.exit(1); });
