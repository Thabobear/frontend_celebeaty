// app/login.tsx
import { useEffect } from 'react';
import { View, Text, Button, Alert } from 'react-native';
import * as WebBrowser from 'expo-web-browser';
import * as Linking from 'expo-linking';

const BACKEND = process.env.EXPO_PUBLIC_BACKEND_URL!;
const RETURN_SCHEME = 'celebeaty://auth'; // muss zum scheme in app.json passen

export default function Login() {
  useEffect(() => {
    const sub = Linking.addEventListener('url', (event) => {
      const url = event.url;
      // Beispiel: celebeaty://auth?ok=1
      const params = Linking.parse(url)?.queryParams || {};
      if (params.ok === '1') {
        Alert.alert('Login erfolgreich', 'Du bist jetzt eingeloggt.');
        // TODO: ggf. State setzen / zur Hauptansicht navigieren
      } else {
        Alert.alert('Login fehlgeschlagen', JSON.stringify(params));
      }
    });
    return () => sub.remove();
  }, []);

  return (
    <View style={{ flex:1, alignItems:'center', justifyContent:'center', gap:12 }}>
      <Text style={{ fontSize:18, fontWeight:'600' }}>Mit Spotify einloggen</Text>
      <Button
        title="Login starten"
        onPress={async () => {
          try {
            const url = `${BACKEND}/login?return_to=${encodeURIComponent(RETURN_SCHEME)}`;
            await WebBrowser.openBrowserAsync(url);
          } catch (e:any) {
            Alert.alert('Fehler', e?.message ?? String(e));
          }
        }}
      />
    </View>
  );
}
