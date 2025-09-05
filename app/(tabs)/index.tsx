// app/(tabs)/index.tsx
import React, { useState, useEffect, useCallback } from "react";
import { View, Text, Pressable, ActivityIndicator, Alert } from "react-native";
import * as WebBrowser from "expo-web-browser";
import * as Linking from "expo-linking";
import Constants from "expo-constants";

WebBrowser.maybeCompleteAuthSession();

const BACKEND_URL = (Constants.expoConfig?.extra as any)?.backendUrl || "";

export default function HomeScreen() {
  const [me, setMe] = useState<{ id: string; display_name?: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");

  useEffect(() => {
    const sub = Linking.addEventListener("url", async ({ url }) => {
      const { path } = Linking.parse(url);
      if (path === "callback") {
        try {
          const r = await fetch(`${BACKEND_URL}/whoami`, { credentials: "include" as any });
          if (r.ok) {
            const j = await r.json();
            setMe({ id: j.id, display_name: j.display_name });
            setMsg("Login erfolgreich ✅");
          } else {
            setMsg("Fehler: whoami fehlgeschlagen");
          }
        } catch {
          setMsg("Netzwerkfehler");
        }
      }
    });
    return () => sub.remove();
  }, []);

  const doLogin = useCallback(async () => {
    if (!BACKEND_URL) return Alert.alert("Fehler", "Backend-URL fehlt in app.json → extra.backendUrl.");
    setBusy(true);
    setMsg("Öffne Spotify Login…");

    const loginUrl = `${BACKEND_URL}/login?platform=mobile`;
    const redirect = Linking.createURL("callback");

    const res = await WebBrowser.openAuthSessionAsync(loginUrl, redirect, { showInRecents: true });
    if (res.type === "success") {
      setMsg("Zurück in der App – prüfe Login…");
      const r = await fetch(`${BACKEND_URL}/whoami`, { credentials: "include" as any });
      if (r.ok) {
        const j = await r.json();
        setMe({ id: j.id, display_name: j.display_name });
        setMsg("Login erfolgreich ✅");
      }
    } else if (res.type === "cancel") {
      setMsg("Login abgebrochen");
    }
    setBusy(false);
  }, []);

  return (
    <View style={{ flex: 1, alignItems: "center", justifyContent: "center", padding: 20 }}>
      <Text style={{ fontSize: 24, fontWeight: "bold", marginBottom: 20 }}>Celebeaty Mobile</Text>
      {me ? (
        <Text>Eingeloggt als: {me.display_name || me.id}</Text>
      ) : (
        <Pressable
          onPress={doLogin}
          style={{
            backgroundColor: "#1DB954",
            padding: 14,
            borderRadius: 10,
            opacity: busy ? 0.6 : 1,
          }}
        >
          {busy ? <ActivityIndicator color="#fff" /> : <Text style={{ color: "#fff" }}>Mit Spotify einloggen</Text>}
        </Pressable>
      )}
      {msg ? <Text style={{ marginTop: 20 }}>{msg}</Text> : null}
    </View>
  );
}
