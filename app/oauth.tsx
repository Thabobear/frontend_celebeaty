// app/oauth.tsx
import { useEffect } from "react";
import * as Linking from "expo-linking";
import { router } from "expo-router";
import { View, Text, ActivityIndicator } from "react-native";

export default function OAuthReturn() {
  useEffect(() => {
    // Hier könnten wir state/code auswerten — nötig ist es nicht,
    // da das Backend Cookies setzt. Wir navigieren einfach zurück.
    const url = Linking.useURL(); // nur fürs Debugging, falls gewünscht
    // Kleine Verzögerung, damit Safari/Chrome die Cookies sicher schreibt:
    const t = setTimeout(() => router.replace("/"), 600);
    return () => clearTimeout(t);
  }, []);

  return (
    <View style={{ flex: 1, alignItems:"center", justifyContent:"center", gap: 12 }}>
      <ActivityIndicator />
      <Text>Zurück zur App…</Text>
    </View>
  );
}
