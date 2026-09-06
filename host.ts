import { experimental_defineHostEntry } from "@get-bb/plugin-sdk/host";
import { hostContract } from "./contract.js";
import {
  getStatus,
  navigateBrowser,
  startBrowser,
  stopBrowser,
} from "./lib/manager.js";

export default experimental_defineHostEntry({
  contract: hostContract,
  handlers: {
    async start({ mode, url }) {
      return await startBrowser({ mode, url });
    },
    async stop() {
      return await stopBrowser();
    },
    async status() {
      return getStatus();
    },
    async navigate({ url }) {
      await navigateBrowser(url);
      return getStatus();
    },
  },
});
