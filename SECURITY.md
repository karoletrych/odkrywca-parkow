# Bezpieczeństwo

## Model

Aplikacja jest statyczna. Nie ma backendu, logowania, cookies sesyjnych ani bazy danych po stronie serwera. Cała logika działa w przeglądarce, a dane użytkownika są przechowywane w `localStorage` pod kluczem `odkrywca-parkow.state.v1`.

Repozytorium GitHub Pages zawiera tylko kod i publiczne dane parków. `data/state.json` (z lokalizacją startu i historią odwiedzin) jest ignorowany przez git. Workflow deployujący sprawdza, czy w `public/` nie ma `state.json`, logów ani `.env`.

## Co jest prywatne

- współrzędne wybranego startu i zapisanych tras,
- daty odwiedzin parków i notatki,
- ustawienia (liczba parków, kategorie, opcje trasy).

Te dane nie są wysyłane do autora aplikacji. Mogą być wysłane wyłącznie do publicznych usług OSM w zakresie potrzebnym do policzenia trasy:

- OSRM (`router.project-osrm.org`) — współrzędne startu i parków, geometria,
- Valhalla (`valhalla1.openstreetmap.de`) — współrzędne startu i parków,
- Nominatim (`nominatim.openstreetmap.org`) — współrzędne klikniętego startu przy reverse geocodingu.

Kafelki mapy są pobierane z `tile.openstreetmap.org`. Adresy IP i nagłówki żądań widzi dostawca tych usług, tak jak przy każdej mapie online.

## Zabezpieczenia w kodzie

- **CSP** w `<meta>` i w lokalnym serwerze: `script-src 'self'`, restrykcyjne `connect-src`/`img-src`, `object-src 'none'`, `base-uri 'none'`, `form-action 'none'`.
- **Brak CDN i analityki** — Leaflet, generator QR, CSS i dane są lokalne. Service worker nie cache'uje skryptów z innych originów.
- **Import JSON**:
  - limit 2 MB,
  - walidacja typów, identyfikatorów parków, dat, współrzędnych i długości tekstów,
  - limit 200 tras i 30 przystanków na trasę,
  - odrzucanie nieznanych pól i kluczy (m.in. `__proto__`),
  - escapowanie etykiet przy renderowaniu (`textContent`/`esc`), brak `eval` i wstrzykiwania HTML z pliku.
- **Renderowanie** używa escapowania dla nazw, etykiet, podpowiedzi i adresów; adresy szczegółów są ograniczone do `https:`.
- **Service worker** obsługuje tylko własny origin i tylko `GET`; nie cache'uje odpowiedzi usług trasujących.
- **Lokalny serwer** (`server.js`) serwuje wyłącznie `public/`, blokuje path traversal i dotfiles, ustawia nagłówki bezpieczeństwa i domyślnie nasłuchuje tylko na `127.0.0.1`.
- **GitHub Actions** ma minimalne uprawnienia (`contents: read`, `pages: write`, `id-token: write`) i nie publikuje katalogu `data/`.

## Ograniczenia

1. **Wspólny origin GitHub Pages.** `localStorage` jest wspólny dla całego `karoletrych.github.io`. Inna strona hostowana na tym samym koncie technicznym może odczytać dane tej aplikacji. Jeśli przechowujesz tam inne aplikacje lub chcesz silniejszej izolacji, użyj osobnego konta GitHub Pages albo własnej domeny.
2. **Brak szyfrowania lokalnego.** Każdy, kto ma dostęp do odblokowanego profilu przeglądarki, może odczytać dane. Eksport JSON też jest jawny — chroń plik jak każdą kopię z lokalizacją.
3. **Brak ochrony przed clickjackingiem na GitHub Pages.** GitHub Pages nie pozwala ustawiać własnych nagłówków `X-Frame-Options`/`frame-ancestors`. Lokalny serwer ustawia `X-Frame-Options: DENY`, ale wersja na Pages polega na polityce przeglądarki. Ryzyko jest niskie dla aplikacji bez logowania i akcji finansowych.
4. **Zewnętrzne usługi OSM** mogą być niedostępne, mieć limity lub zmienić politykę. Aplikacja wtedy liczy część odległości w linii prostej i to sygnalizuje; nie jest to luka bezpieczeństwa.
5. **Service worker i cache** mogą przez chwilę serwować starszą wersję po deployu. Wersja cache jest w `public/sw.js` (`VERSION`); podnieś ją przy większych zmianach.

## Zgłaszanie

Jeśli znajdziesz problem, nie publikuj danych osobowych ani exploitów w publicznym issue. Otwórz prywatny security advisory w repozytorium GitHub albo skontaktuj się z właścicielem konta `karoletrych`.
