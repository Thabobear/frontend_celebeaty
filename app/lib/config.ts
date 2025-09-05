// app/lib/config.ts
import Constants from "expo-constants";

const extra = (Constants.expoConfig as any)?.extra ?? {};
export const BACKEND_URL: string = (extra.backendUrl as string)?.replace(/\/+$/, "") || "";
export const WS_URL: string = BACKEND_URL.replace(/^http/, "ws");
export const APP_SCHEME: string = (extra.scheme as string) || "celebeatymobile";
export const REDIRECT_PATH = "oauth";                     // muss zu app.json matching "oauth" passen
export const REDIRECT_URL = `${APP_SCHEME}://${REDIRECT_PATH}`;
