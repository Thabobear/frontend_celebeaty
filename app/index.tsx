// app/index.tsx
import React, { useEffect, useRef, useState, useMemo } from "react";
import {
  View,
  Text,
  ScrollView,
  TouchableOpacity,
  StyleSheet,
  Image,
  Platform,
  Linking,
} from "react-native";
import * as AuthSession from "expo-auth-session";
import * as WebBrowser from "expo-web-browser";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import Constants from "expo-constants";

WebBrowser.maybeCompleteAuthSession();

/* ================== Config ================== */
const BACKEND = process.env.EXPO_PUBLIC_BACKEND_URL || "http://localhost:3001";
const WS_URL = BACKEND.replace(/^http/, "ws");

// Spotify Client ID (PKCE; ohne Secret)
const SPOTIFY_CLIENT_ID = "8c819b73116243f6bcc5dc3a3f042a27";

const DISCOVERY = {
  authorizationEndpoint: "https://accounts.spotify.com/authorize",
  tokenEndpoint: "https://accounts.spotify.com/api/token",
};

const SCOPES = [
  "user-read-playback-state",
  "user-read-currently-playing",
  "user-modify-playback-state",
  "user-read-email",
  "user-read-private",
].join(" ");

console.log("[DEBUG] expo owner/slug:",
  Constants?.expoConfig?.owner, Constants?.expoConfig?.slug);

/** ========= REDIRECT-URI: eine Quelle =========
 * DEV/Expo-Go: Expo-Proxy-URL (muss bei Spotify whitelisted sein)
 * Standalone (PROD): App-Schema celebeaty://auth
 */
const EXPO_PROXY_REDIRECT = "https://auth.expo.io/@danzotti/celebeaty-mobile";
const NATIVE_REDIRECT = "celebeaty://auth";
const REDIRECT_URI = __DEV__ ? EXPO_PROXY_REDIRECT : NATIVE_REDIRECT;
console.log("[DEBUG] redirectUri =", REDIRECT_URI);

/* ================== Helpers ================== */
const nowTs = () => Date.now();
function msToMMSS(ms = 0) {
  const s = Math.max(0, Math.floor(ms / 1000));
  const mm = String(Math.floor(s / 60)).padStart(2, "0");
  const ss = String(s % 60).padStart(2, "0");
  return `${mm}:${ss}`;
}
function fmtTs(ts: number) {
  const d = new Date(ts);
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  const ss = String(d.getSeconds()).padStart(2, "0");
  return `${hh}:${mm}:${ss}`;
}

type Me = { id: string; display_name: string | null };
type TrackUI = {
  id: string;
  name?: string;
  artists?: string[];
  image?: string | null;
  progress_ms?: number;
  is_playing?: boolean;
  senderName?: string;
};

/* =========================================================== */

export default function Home() {
  const insets = useSafeAreaInsets();

  // ===== Auth & User =====
  const [accessToken, setAccessToken] = useState<string | null>(null);
  const [refreshToken, setRefreshToken] = useState<string | null>(null);
  const [me, setMe] = useState<Me | null>(null);

  // ===== Mode: idle | sender | receiver =====
  const [mode, setMode] = useState<"idle" | "sender" | "receiver">("idle");

  // ===== Sender / Empfänger State =====
  const [isSharing, setIsSharing] = useState(false);
  const [senderNow, setSenderNow] = useState<TrackUI | null>(null);

  const [followingUserId, setFollowingUserId] = useState<string | null>(null);
  const [recvNow, setRecvNow] = useState<TrackUI | null>(null);

  // Lobby
  const [sessions, setSessions] = useState<
    Array<{ user_id: string; name: string; since?: string }>
  >([]);

  // UI
  const [hint, setHint] = useState<string>("");
  const [dbgOpen, setDbgOpen] = useState<boolean>(false);
  const [dbgLines, setDbgLines] = useState<
    Array<{ ts: number; level: string; text: string }>
  >([]);

  // WS & Ticker
  const ws = useRef<WebSocket | null>(null);
  const wsState = useRef<"CLOSED" | "CONNECTING" | "OPEN">("CLOSED");
  const recvTicker = useRef<any>(null);
  const recvClockRef = useRef({
    snapshotTs: 0,
    snapshotProgress: 0,
    is_playing: false,
  });

  const log = {
    d: (...a: any[]) => pushLog("debug", a),
    w: (...a: any[]) => pushLog("warn", a),
    e: (...a: any[]) => pushLog("error", a),
  };
  function pushLog(level: "debug" | "warn" | "error", args: any[]) {
    const text = args
      .map((x) => {
        try {
          return typeof x === "string" ? x : JSON.stringify(x);
        } catch {
          return String(x);
        }
      })
      .join(" ");
    setDbgLines((prev) => {
      const next = [...prev, { ts: Date.now(), level, text }];
      if (next.length > 700) next.splice(0, next.length - 700);
      return next;
    });
  }

  // ===== PKCE-Anfrage (einheitliche redirectUri) =====
  const [request, response, promptAsync] = AuthSession.useAuthRequest(
    {
      clientId: SPOTIFY_CLIENT_ID,
      responseType: AuthSession.ResponseType.Code,
      scopes: SCOPES.split(" "),
      redirectUri: REDIRECT_URI, // <- exakt diese URI verwenden
      usePKCE: true,
    },
    DISCOVERY
  );

  // ===== Nach erfolgreichem Login: Code tauschen =====
  useEffect(() => {
    console.log("[DEBUG] response changed:", response);

    const exchange = async () => {
      try {
        if (!response) return;

        if (response.type !== "success") {
          console.log(
            "[DEBUG] response.type is not success:",
            response.type,
            (response as any)?.params
          );
          return;
        }

        if (!request?.codeVerifier) {
          console.log("[DEBUG] missing codeVerifier");
          return;
        }

        const code = (response as any).params?.code;
        console.log(
          "[DEBUG] exchanging code for token with redirectUri:",
          REDIRECT_URI
        );

        const form = new URLSearchParams();
        form.set("grant_type", "authorization_code");
        form.set("code", String(code));
        form.set("redirect_uri", REDIRECT_URI); // <- identisch!
        form.set("client_id", SPOTIFY_CLIENT_ID);
        form.set("code_verifier", request.codeVerifier);

        const res = await fetch(DISCOVERY.tokenEndpoint, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: form.toString(),
        });

        const text = await res.text();
        console.log("[DEBUG] token response", res.status, text);

        if (!res.ok) {
          throw new Error(`HTTP ${res.status}: ${text}`);
        }

        let j: any = {};
        try {
          j = JSON.parse(text);
        } catch {
          throw new Error("Token JSON parse failed: " + text);
        }

        setAccessToken(j.access_token);
        setRefreshToken(j.refresh_token || null);
        log.d("Token ok; expires_in", j.expires_in);
      } catch (e: any) {
        log.e("Token exchange failed", e?.message || String(e));
      }
    };

    exchange();
  }, [response, request?.codeVerifier]);

  // ===== /whoami =====
  useEffect(() => {
    if (!accessToken) return;
    (async () => {
      try {
        const res = await fetch(`${BACKEND}/whoami`, {
          headers: authHeaders(accessToken, refreshToken),
        });
        const j = await res.json();
        if (!res.ok) throw new Error(JSON.stringify(j));
        const display = j.display_name || j.id || "Unbekannt";
        setMe({ id: j.id, display_name: display });
        log.d("whoami:", display, j.id);
      } catch (e: any) {
        log.w("whoami error:", e?.message || String(e));
      }
    })();
  }, [accessToken, refreshToken]);

  // ===== WebSocket =====
  useEffect(() => {
    if (!me?.id) return;

    let closedByApp = false;
    let backoff = 500;

    const connect = () => {
      const socket = new WebSocket(WS_URL);
      ws.current = socket;
      wsState.current = "CONNECTING";
      let sendQueue: any[] = [];
      log.d("WS connecting", WS_URL);

      socket.onopen = () => {
        backoff = 500;
        wsState.current = "OPEN";
        log.d("WS open");
        socket.send(
          JSON.stringify({
            type: "hello",
            userId: me.id,
            name: me.display_name,
            ts: nowTs(),
          })
        );
        log.d("WS → hello", me.id);

        if (mode === "receiver" && followingUserId) {
          socket.send(JSON.stringify({ type: "follow", followingUserId }));
          log.d("WS → follow", followingUserId);
        }

        if (sendQueue.length) {
          sendQueue.forEach((m) => socket.send(JSON.stringify(m)));
          log.d("WS flush queue", sendQueue.length);
          sendQueue = [];
        }
      };

      socket.onmessage = async (ev) => {
        let data: any;
        try {
          data = JSON.parse(ev.data as any);
        } catch {
          return;
        }
        if (!data?.type) return;

        if (data.type === "track") {
          if (mode !== "receiver") return;
          if (followingUserId && data.user?.id !== followingUserId) return;

          const { kind, trackId, progress_ms, name, artists, image, is_playing } =
            data;
          log.d(
            "WS ⇠",
            kind || "track",
            trackId,
            progress_ms,
            is_playing ? "▶︎" : "⏸"
          );

          setRecvNow({
            id: trackId,
            name: name || trackId,
            artists: artists || [],
            progress_ms: progress_ms || 0,
            image: image || null,
            senderName: data.user?.name || "Sender",
            is_playing: !!is_playing,
          });

          // sanfter UI-Ticker
          recvClockRef.current.snapshotTs = Date.now();
          recvClockRef.current.snapshotProgress = progress_ms || 0;
          recvClockRef.current.is_playing = !!is_playing;

          if (recvTicker.current) {
            clearInterval(recvTicker.current);
            recvTicker.current = null;
          }
          if (is_playing) {
            recvTicker.current = setInterval(() => {
              setRecvNow((prev) => {
                if (!prev) return prev;
                const elapsed = Math.min(
                  Date.now() - recvClockRef.current.snapshotTs,
                  1200
                );
                const next =
                  (recvClockRef.current.snapshotProgress || 0) + elapsed;
                return { ...prev, progress_ms: next };
              });
            }, 1000);
          }

          if (kind === "trackchange" || kind === "seek") {
            await ensurePlaybackAlignedViaProxy({
              trackId,
              positionMs: progress_ms || 0,
              shouldPlay: !!is_playing,
              forcePosition: true,
              setHint,
              accessToken,
              refreshToken,
            });
          } else if (kind === "playstate") {
            await ensurePlaybackAlignedViaProxy({
              trackId,
              positionMs: progress_ms || 0,
              shouldPlay: !!is_playing,
              forcePosition: false,
              setHint,
              accessToken,
              refreshToken,
            });
          }
        }
      };

      socket.onclose = () => {
        if (closedByApp) return;
        wsState.current = "CLOSED";
        log.w("WS closed – reconnecting…");
        backoff = Math.min(backoff * 2, 8000);
        setTimeout(connect, backoff);
      };

      socket.onerror = (e: any) => {
        log.w("WS error", e?.message || String(e));
        try {
          socket.close();
        } catch {}
      };

      (socket as any).safeSend = (obj: any) => {
        const ready = socket && socket.readyState === WebSocket.OPEN;
        if (ready) socket.send(JSON.stringify(obj));
        else sendQueue.push(obj);
      };
    };

    connect();
    return () => {
      closedByApp = true;
      try {
        ws.current?.close();
      } catch {}
      if (recvTicker.current) {
        clearInterval(recvTicker.current);
        recvTicker.current = null;
      }
    };
  }, [me?.id, followingUserId, mode]);

  // ===== Lobby =====
  useEffect(() => {
    const load = async () => {
      try {
        const res = await fetch(`${BACKEND}/sessions/active`);
        const j = await res.json();
        const list = (j.sessions || []).map((s: any) => ({
          user_id: s.user_id,
          name: s.name,
          since: s.since,
        }));
        setSessions(list);
      } catch {}
    };
    load();
    const t = setInterval(load, 5000);
    return () => clearInterval(t);
  }, []);

  // ===== Sender Control =====
  async function startShare() {
    if (!accessToken) {
      setHint("Bitte erst einloggen.");
      return;
    }
    try {
      const res = await fetch(`${BACKEND}/share/start`, {
        method: "POST",
        headers: authHeaders(accessToken, refreshToken),
      });
      const j = await res.json();
      log.d("share/start:", res.status, JSON.stringify(j));
      if (!res.ok) throw new Error(JSON.stringify(j));
      setMode("sender");
      setIsSharing(true);
      setHint(
        "Teilen aktiv. Du kannst Spotify in den Vordergrund holen – der Server pollt weiter."
      );

      try {
        const r = await fetch(`${BACKEND}/currently-playing`, {
          headers: authHeaders(accessToken, refreshToken),
        });
        const d = await r.json();
        if (d?.track?.id) {
          setSenderNow({
            id: d.track.id,
            name: d.track.name,
            artists: d.track.artists || [],
            image: d.track.album?.images?.[0]?.url || null,
            progress_ms: d.progress_ms || 0,
            is_playing: !!d.is_playing,
          });
        }
      } catch {}
    } catch (e: any) {
      setHint("Konnte Teilen nicht starten. Bitte neu einloggen.");
      log.w(e?.message || String(e));
    }
  }

  async function stopShare() {
    try {
      const res = await fetch(`${BACKEND}/share/stop`, {
        method: "POST",
        headers: authHeaders(accessToken, refreshToken),
      });
      const j = await res.json();
      log.d("share/stop:", res.status, JSON.stringify(j));
    } catch {}
    setIsSharing(false);
    setMode("idle");
  }

  // ===== Lobby-Liste ohne mich selbst =====
  const liveList = useMemo(() => {
    if (!me?.id) return sessions;
    return sessions.filter((s) => s.user_id !== me.id);
  }, [sessions, me?.id]);

  /* ================== UI ================== */
  if (!accessToken || !me) {
    return (
      <ScrollView style={[styles.container, { paddingTop: insets.top + 12 }]}>
        <BrandHeader me={null} />
        <View style={styles.card}>
          <Text style={styles.h2}>Login mit Spotify</Text>
          <Text style={styles.p}>
            Sieh, wer gerade teilt – oder starte deine eigene Live-Session.
          </Text>
          <View style={styles.row}>
            <PrimaryButton
              title="Mit Spotify einloggen"
              onPress={async () => {
                console.log("[DEBUG] login tapped, redirect =", REDIRECT_URI);
                try {
                  // DEV → Proxy; PROD → kein Proxy (Standalone)
                  const result = await promptAsync(
                    __DEV__
                      ? {
                          useProxy: true,
                          projectNameForProxy: "@danzotti/celebeaty-mobile",
                          preferEphemeralSession: true,
                        }
                      : {
                          useProxy: false,
                        }
                  );
                  console.log("[DEBUG] promptAsync result:", result);
                } catch (e: any) {
                  log.e("promptAsync error", e?.message || String(e));
                }
              }}
              disabled={!request}
            />
          </View>
          <Text style={styles.smallMuted}>Redirect: {short(REDIRECT_URI)}</Text>
        </View>
        <DebugConsole
          open={dbgOpen}
          setOpen={setDbgOpen}
          lines={dbgLines}
          wsState={wsState.current}
          mode={"idle"}
          me={null}
          followingUserId={null}
          isSharing={false}
        />
      </ScrollView>
    );
  }

  return (
    <ScrollView style={[styles.container, { paddingTop: insets.top + 12 }]}>
      <BrandHeader me={me} />

      {hint ? (
        <View style={styles.hint}>
          <Text style={styles.hintText}>{hint}</Text>
        </View>
      ) : null}

      {/* Sender */}
      {mode === "sender" && (
        <View style={styles.card}>
          <View style={styles.liveBadge}>
            <Text style={styles.liveBadgeText}>LIVE</Text>
          </View>
          <Text style={styles.h2}>Du teilst gerade Musik</Text>
          {!senderNow && <Text style={styles.p}>Warte auf laufenden Song…</Text>}
          {senderNow && <NowPlayingBox title={`Aktuell`} track={senderNow} />}

          <View style={styles.row}>
            <ButtonSecondary title="Teilen stoppen" onPress={stopShare} />
          </View>
        </View>
      )}

      {/* Receiver */}
      {mode === "receiver" && (
        <View style={styles.card}>
          <Text style={styles.h2}>
            Du und {recvNow?.senderName || "dein Sender"} hört gerade:
          </Text>
          {!recvNow && (
            <Text style={styles.p}>
              Du hörst gleich mit! Beim nächsten Song bist du dabei.
            </Text>
          )}
          {recvNow && <NowPlayingBox title="Gerade beim Empfänger" track={recvNow} />}
          {!!hint && (
            <View style={styles.row}>
              <PrimaryButton
                title="Erneut verbinden"
                onPress={async () => {
                  if (!recvNow?.id) {
                    setHint(
                      "Noch kein Track empfangen – du steigst beim nächsten Song automatisch ein."
                    );
                    return;
                  }
                  await ensurePlaybackAlignedViaProxy({
                    trackId: recvNow.id,
                    positionMs: recvNow.progress_ms || 0,
                    shouldPlay: true,
                    forcePosition: false,
                    setHint,
                    accessToken,
                    refreshToken,
                  });
                }}
              />
              <ButtonSecondary
                title="Spotify öffnen"
                onPress={() => Linking.openURL("spotify://")}
              />
            </View>
          )}
          <View style={[styles.row, { marginTop: 8 }]}>
            <ButtonSecondary
              title="Verlassen"
              onPress={() => {
                setMode("idle");
                setRecvNow(null);
                setFollowingUserId(null);
                if (recvTicker.current) {
                  clearInterval(recvTicker.current);
                  recvTicker.current = null;
                }
              }}
            />
          </View>
        </View>
      )}

      {/* Lobby */}
      {mode === "idle" && (
        <>
          <View className="sectionHead" style={styles.sectionHead}>
            <Text style={styles.h2}>Gerade live</Text>
            <Text style={styles.smallMuted}>{liveList.length} Sender</Text>
          </View>

          {liveList.length === 0 && (
            <View style={[styles.card, styles.mutedCard]}>
              <Text style={styles.p}>
                Niemand teilt gerade – starte selbst oder warte auf eine Einladung.
              </Text>
            </View>
          )}

          {liveList.map((u) => (
            <View key={u.user_id} style={styles.roomCard}>
              <View style={styles.roomHeader}>
                <View style={styles.avatar}>
                  <Text style={styles.avatarTxt}>
                    {(u.name || "?").slice(0, 1)}
                  </Text>
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={styles.roomName}>{u.name || "Unbekannt"}</Text>
                  {!!u.since && (
                    <Text style={styles.roomSince}>
                      seit {new Date(u.since).toLocaleTimeString()}
                    </Text>
                  )}
                </View>
                <View style={styles.dotLive} />
              </View>
              <View style={styles.row}>
                <PrimaryButton
                  title="Mitspielen"
                  onPress={() => {
                    setFollowingUserId(u.user_id);
                    setMode("receiver");
                    setHint(
                      "Du hörst gleich bei diesem User mit! Beim nächsten Song bist du dabei!"
                    );
                    if (ws.current && ws.current.readyState === WebSocket.OPEN) {
                      ws.current.send(
                        JSON.stringify({
                          type: "follow",
                          followingUserId: u.user_id,
                        })
                      );
                    }
                  }}
                />
                <ButtonSecondary
                  title="Spotify öffnen"
                  onPress={() => Linking.openURL("spotify://")}
                />
              </View>
            </View>
          ))}

          <View style={styles.card}>
            <Text style={styles.h2}>Selbst teilen</Text>
            <Text style={styles.p}>
              Starte deine Live-Session. Dein Gerät darf in den Hintergrund – der
              Server pollt.
            </Text>
            <View style={styles.row}>
              <PrimaryButton title="Live teilen starten" onPress={startShare} />
            </View>
          </View>
        </>
      )}

      <DebugConsole
        open={dbgOpen}
        setOpen={setDbgOpen}
        lines={dbgLines}
        wsState={wsState.current}
        mode={mode}
        me={me}
        followingUserId={followingUserId}
        isSharing={isSharing}
      />
      <View style={{ height: insets.bottom + 24 }} />
    </ScrollView>
  );
}

/* ===== Backend Proxies ===== */
function authHeaders(accessToken: string | null, refreshToken: string | null) {
  const h: any = {};
  if (accessToken) h["Authorization"] = `Bearer ${accessToken}`;
  if (refreshToken) h["x-refresh-token"] = refreshToken;
  h["Content-Type"] = "application/json";
  return h;
}

async function getDevicesViaProxy({ accessToken, refreshToken }: any) {
  const r = await fetch(`${BACKEND}/spotify/devices`, {
    headers: authHeaders(accessToken, refreshToken),
  });
  if (!r.ok) return { devices: [] };
  return r.json();
}
async function transferViaProxy({ device_id, play, accessToken, refreshToken }: any) {
  return fetch(`${BACKEND}/spotify/transfer`, {
    method: "POST",
    headers: authHeaders(accessToken, refreshToken),
    body: JSON.stringify({ device_id, play }),
  });
}
async function playViaProxy({ body, accessToken, refreshToken }: any) {
  return fetch(`${BACKEND}/spotify/play`, {
    method: "POST",
    headers: authHeaders(accessToken, refreshToken),
    body: JSON.stringify(body || {}),
  });
}
async function pauseViaProxy({ accessToken, refreshToken }: any) {
  return fetch(`${BACKEND}/spotify/pause`, {
    method: "POST",
    headers: authHeaders(accessToken, refreshToken),
  });
}

const alignCooldown = { ts: 0 };
async function ensurePlaybackAlignedViaProxy({
  trackId,
  positionMs,
  shouldPlay,
  forcePosition,
  setHint,
  accessToken,
  refreshToken,
}: {
  trackId: string;
  positionMs: number;
  shouldPlay: boolean;
  forcePosition: boolean;
  setHint: (s: string) => void;
  accessToken: string | null;
  refreshToken: string | null;
}) {
  try {
    const now = Date.now();
    if (now - (alignCooldown.ts || 0) < 400) return;
    alignCooldown.ts = now;

    const devJson = await getDevicesViaProxy({ accessToken, refreshToken });
    const devices = devJson.devices || [];
    if (!devices.length) {
      setHint?.(
        "Kein Spotify-Gerät gefunden. Öffne die Spotify-App, spiele kurz etwas ab, pausiere und kehre zurück."
      );
      return;
    }
    let device =
      devices.find((d: any) => d.is_active) ||
      devices.find((d: any) => !d.is_restricted) ||
      devices[0];

    if (!device.is_active) {
      await transferViaProxy({ device_id: device.id, play: true, accessToken, refreshToken });
      await new Promise((r) => setTimeout(r, 450));
    }

    if (!shouldPlay) {
      const res = await pauseViaProxy({ accessToken, refreshToken });
      if (!res.ok && ![202, 204, 403, 404].includes(res.status)) {
        const t = await res.text();
        setHint?.(`Pause-Fehler ${res.status}: ${t.slice(0, 160)}`);
      } else {
        setHint?.("");
      }
      return;
    }

    const body = forcePosition
      ? { uris: [`spotify:track:${trackId}`], position_ms: positionMs }
      : {};
    const playRes = await playViaProxy({ body, accessToken, refreshToken });
    if (!playRes.ok) {
      const text = await playRes.text();
      const status = playRes.status;
      if (status === 403 || status === 404)
        setHint?.(
          "Auto-Start nicht möglich. Öffne Spotify und tippe hier auf „Erneut verbinden“."
        );
      else if (status === 401)
        setHint?.("Deine Sitzung ist abgelaufen. Bitte neu einloggen.");
      else setHint?.(`Playback-Fehler ${status}: ${text.slice(0, 200)}`);
      return;
    }
    setHint?.("");
  } catch {
    setHint?.(
      "Fehler bei der Wiedergabe-Steuerung. Öffne Spotify und versuche es erneut."
    );
  }
}

/* ================== UI ================== */
function BrandHeader({ me }: { me: Me | null }) {
  return (
    <View style={styles.header}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
        <View style={styles.logoDot} />
        <Text style={styles.brand}>Celebeaty</Text>
      </View>
      {me ? (
        <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
          <View style={styles.avatar}>
            <Text style={styles.avatarTxt}>
              {(me.display_name || "?").slice(0, 1)}
            </Text>
          </View>
          <Text style={styles.userName}>{me.display_name}</Text>
        </View>
      ) : null}
    </View>
  );
}

function NowPlayingBox({ title, track }: { title: string; track: TrackUI }) {
  return (
    <View style={styles.nowPlaying}>
      <Text style={styles.h3}>{title}</Text>
      <View style={{ flexDirection: "row", gap: 12, alignItems: "center", marginTop: 8 }}>
        {!!track?.image && (
          <Image
            source={{ uri: track.image! }}
            style={{ width: 64, height: 64, borderRadius: 8 }}
          />
        )}
        <View style={{ flex: 1 }}>
          <Text style={styles.title}>{track?.name || "Unbekannter Titel"}</Text>
          <Text style={styles.artist}>{(track?.artists || []).join(", ")}</Text>
          <Text style={styles.time}>{msToMMSS(track?.progress_ms || 0)}</Text>
        </View>
      </View>
    </View>
  );
}

function PrimaryButton({
  title,
  onPress,
  disabled,
}: {
  title: string;
  onPress: () => void;
  disabled?: boolean;
}) {
  return (
    <TouchableOpacity
      onPress={onPress}
      disabled={disabled}
      style={[styles.btn, styles.btnPrimary, disabled && styles.btnDisabled]}
    >
      <Text style={styles.btnPrimaryTxt}>{title}</Text>
    </TouchableOpacity>
  );
}
function ButtonSecondary({ title, onPress }: { title: string; onPress: () => void }) {
  return (
    <TouchableOpacity onPress={onPress} style={[styles.btn, styles.btnGhost]}>
      <Text style={styles.btnGhostTxt}>{title}</Text>
    </TouchableOpacity>
  );
}

function short(s: string) {
  return s.length > 56 ? s.slice(0, 53) + "…" : s;
}

function DebugConsole({
  open,
  setOpen,
  lines,
  wsState,
  mode,
  me,
  followingUserId,
  isSharing,
}: any) {
  const header =
    `CB DEBUG ${new Date().toISOString()}\n` +
    `ws=${wsState} | mode=${mode} | me=${me?.id || "-"} | follow=${followingUserId || "-"} | sharing=${isSharing}\n` +
    `--------------------------------------------------------------------------------`;
  return (
    <>
      <TouchableOpacity
        style={styles.dbgFab}
        onPress={() => setOpen(!open)}
        accessibilityLabel="Debug-Konsole"
      >
        <Text style={{ fontSize: 18 }}>🐞</Text>
      </TouchableOpacity>
      {open && (
        <View style={styles.dbgPanel}>
          <View style={styles.dbgHead}>
            <Text style={styles.dbgStat}>
              WS: {wsState} | Mode: {mode} | Me: {me?.id || "–"} | Follow{" "}
              {followingUserId || "–"} | Sharing: {String(isSharing)}
            </Text>
            <View style={{ flexDirection: "row", gap: 8 }}>
              <ButtonSecondary title="Close" onPress={() => setOpen(false)} />
            </View>
          </View>
          <ScrollView style={styles.dbgBody}>
            <Text
              selectable
              style={{
                fontFamily: Platform.OS === "ios" ? "Menlo" : "monospace",
                marginBottom: 8,
              }}
            >
              {header}
            </Text>
            {lines.length === 0 ? (
              <Text style={styles.dbgEmpty}>Keine Logs bisher…</Text>
            ) : (
              lines.map((l: any, i: number) => (
                <Text
                  key={i}
                  selectable
                  style={{
                    fontFamily:
                      Platform.OS === "ios" ? "Menlo" : "monospace",
                  }}
                >
                  [{fmtTs(l.ts)}] {l.level.toUpperCase()} {l.text}
                </Text>
              ))
            )}
          </ScrollView>
        </View>
      )}
    </>
  );
}

/* ================== Styles ================== */
const styles = StyleSheet.create({
  container: { flex: 1, paddingHorizontal: 16, backgroundColor: "#0b0b0c" },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: 12,
  },
  logoDot: { width: 20, height: 20, borderRadius: 10, backgroundColor: "#d9c4a1" },
  brand: { color: "#fff", fontSize: 20, fontWeight: "800" },
  userName: { color: "#fff", fontSize: 14 },
  avatar: {
    width: 28,
    height: 28,
    borderRadius: 14,
    backgroundColor: "#222",
    alignItems: "center",
    justifyContent: "center",
  },
  avatarTxt: { color: "#fff", fontWeight: "700" },

  card: {
    backgroundColor: "#121214",
    borderRadius: 12,
    padding: 14,
    marginBottom: 14,
    borderWidth: 1,
    borderColor: "#1f1f21",
  },
  mutedCard: { opacity: 0.8 },
  sectionHead: {
    flexDirection: "row",
    alignItems: "baseline",
    justifyContent: "space-between",
    marginBottom: 8,
  },
  smallMuted: { color: "#9aa0a6", fontSize: 12 },

  h2: { color: "#fff", fontSize: 18, fontWeight: "700", marginBottom: 6 },
  h3: { color: "#fff", fontSize: 15, fontWeight: "600" },
  p: { color: "#d7dadf", fontSize: 14 },
  title: { color: "#fff", fontSize: 16, fontWeight: "700" },
  artist: { color: "#c6cacc", fontSize: 13 },
  time: { color: "#9aa0a6", marginTop: 4 },

  row: { flexDirection: "row", gap: 10, marginTop: 10 },

  btn: { paddingVertical: 10, paddingHorizontal: 14, borderRadius: 10 },
  btnPrimary: { backgroundColor: "#d9c4a1" },
  btnPrimaryTxt: { color: "#111", fontWeight: "800" },
  btnGhost: { borderWidth: 1, borderColor: "#2a2a2d" },
  btnGhostTxt: { color: "#fff", fontWeight: "600" },
  btnDisabled: { opacity: 0.4 },

  liveBadge: {
    alignSelf: "flex-start",
    backgroundColor: "#e34d4d",
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 6,
    marginBottom: 6,
  },
  liveBadgeText: { color: "#fff", fontSize: 12, fontWeight: "700" },

  roomCard: {
    backgroundColor: "#121214",
    borderRadius: 12,
    padding: 14,
    marginBottom: 10,
    borderWidth: 1,
    borderColor: "#1f1f21",
  },
  roomHeader: { flexDirection: "row", alignItems: "center", gap: 10, marginBottom: 8 },
  roomName: { color: "#fff", fontSize: 15, fontWeight: "700" },
  roomSince: { color: "#9aa0a6", fontSize: 12 },
  dotLive: { width: 8, height: 8, borderRadius: 4, backgroundColor: "#2dd36f" },

  nowPlaying: { marginTop: 6 },

  hint: {
    backgroundColor: "#1a1a1d",
    borderRadius: 8,
    padding: 10,
    borderWidth: 1,
    borderColor: "#27272b",
    marginBottom: 10,
  },
  hintText: { color: "#cbd5e1" },

  dbgFab: {
    position: "absolute",
    right: 18,
    bottom: 24,
    backgroundColor: "#2a2a2d",
    borderRadius: 16,
    paddingHorizontal: 12,
    paddingVertical: 8,
    zIndex: 100,
  },
  dbgPanel: {
    position: "absolute",
    left: 12,
    right: 12,
    bottom: 70,
    top: 120,
    backgroundColor: "#101012",
    borderRadius: 12,
    borderWidth: 1,
    borderColor: "#2a2a2d",
    overflow: "hidden",
  },
  dbgHead: {
    padding: 10,
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    borderBottomWidth: 1,
    borderBottomColor: "#222",
  },
  dbgStat: { color: "#9aa0a6", fontSize: 12 },
  dbgBody: { padding: 10 },
  dbgEmpty: { color: "#9aa0a6", fontStyle: "italic" },
});
