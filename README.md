# Odkrywca krakowskich parków

Aplikacja webowa (PWA) z mapą **78 punktów** z odznaki **Odkrywca Krakowskich Parków**, dziennikiem odwiedzin i planerem dziennej trasy pieszej.

Działa **w całości w przeglądarce** — nie ma backendu, konta ani bazy danych. Postępy, trasy i ustawienia są zapisywane w `localStorage` na danym urządzeniu. Możesz je wyeksportować i zaimportować jako plik JSON.

## Online

**https://karoletrych.github.io/odkrywca-parkow/**

Na telefonie: otwórz adres, a następnie „Dodaj do ekranu głównego” / „Zainstaluj aplikację”. Aplikacja jest PWA i po pierwszym otwarciu działa też offline (mapa wymaga internetu, ale trasa i dane nie).

## Funkcje

- 78 oficjalnych punktów i 4 kategorie (historyczny, wodny, leśny, zwykły),
- oznaczanie parków jako zrobione z datą, pasek postępu,
- start z dowolnego miejsca (klik na mapie, przeciągnięcie pinezki, lokalizacja GPS lub park),
- wybór liczby parków (`−` / `+`, suwak, kafelki), kategorie, pomijanie zrobionych, opcja powrotu,
- pod licznikiem parków: podgląd zmiany długości trasy dla `−1`, `+1`…`+4` parków,
- trasa piesza po realnych szlakach (OSRM/Valhalla), heuristiczne rozwiązanie „najtańsze wstawianie + 2-opt + wymiana przystanków”,
- zapisane trasy: podgląd, GPX, Google Maps (do 10 punktów), usuwanie, zbiorcze „Oznacz zrobione”,
- eksport/import wszystkich danych w JSON, z walidacją pliku,
- PWA: instalacja, cache aplikacji, tryb offline.

## Korzystanie z danych

Kliknij ikonę **bazy danych** w prawym górnym rogu:

- **Eksportuj wszystko (JSON)** — kopia postępów, tras i ustawień,
- **Importuj z pliku** — po wczytaniu wybierz **Połącz z obecnymi** (dodaje brakujące wpisy) albo **Zastąp obecne**,
- **Usuń wszystkie dane** — czyści `localStorage` (najpierw zrób kopię).

Import akceptuje też stary plik `data/state.json` z poprzedniej wersji serwerowej. Walidacja odrzuca nieznane parki, limituje rozmiar pliku (2 MB), poprawia daty i czyści etykiety; HTML z pliku nigdy nie jest wstrzykiwany do strony.

Dane są przypisane do **originu** przeglądarki. `localhost:7777`, `127.0.0.1:7777` i `karoletrych.github.io` to trzy różne magazyny — skopiuj dane przez eksport/import, jeśli zmieniasz adres.

## Uruchomienie lokalne (opcjonalnie)

Aplikacja nie potrzebuje serwera. Do lokalnego podglądu możesz użyć dowolnego serwera statycznego skierowanego na `public/`:

```powershell
node server.js
# http://127.0.0.1:7777/
```

`server.js` to **tylko** serwer plików statycznych: nie ma API, nie czyta `data/state.json` i nie zapisuje niczego. Domyślnie słucha na `127.0.0.1` (nie na całej sieci). Możesz też użyć `start.cmd` lub zadania **OdkrywcaParkow**.

Nie otwieraj `public/index.html` bezpośrednio przez `file://` — przeglądarka zablokuje `fetch` danych i service worker.

## Prywatność i bezpieczeństwo

- Postępy i ustawienia **nie są wysyłane na żaden serwer**; zostają w `localStorage`.
- Do wyznaczenia trasy przeglądarka wysyła **tylko współrzędne** startu i parków do publicznych usług OSM:
  - [OSRM](https://project-osrm.org/) — macierz i geometria trasy,
  - [Valhalla/FOSSGIS](https://valhalla1.openstreetmap.de/) — dojście ze startu,
  - [Nominatim](https://nominatim.openstreetmap.org/) — nazwa wybranego startu (max. 1 zapytanie/s, z cache).
- Kafelki mapy pochodzą z [OpenStreetMap](https://www.openstreetmap.org/copyright). Aplikacja jest mała i nie masuje serwerów OSM; przy większym ruchu użyj własnego dostawcy kafelków.
- Strona ma CSP ograniczające skrypty, połączenia i obrazki; Leaflet i generator QR są vendored lokalnie, bez CDN i analityki.
- Import JSON jest walidowany i limitowany; etykiety są escapowane przy renderowaniu, a renderowanie nie używa `eval`.
- Repozytorium jest publiczne, ale **nie zawiera** `data/state.json` ani logów. Workflow GitHub Actions dodatkowo blokuje deploy, jeśli w `public/` znajdzie prywatne pliki.

Ważne ograniczenie GitHub Pages: `localStorage` jest wspólny dla całego originu `karoletrych.github.io`. Inna aplikacja hostowana na tym samym koncie GitHub Pages mogłaby teoretycznie odczytać te dane. Jeśli to istotne, hostuj tę aplikację na osobnym koncie lub własnej domenie. Więcej w [SECURITY.md](SECURITY.md).

## Struktura

```
public/index.html          interfejs
public/app.js              mapa, UI, import/eksport, trasa w przeglądarce
public/state.js            walidacja i scalanie danych (localStorage/JSON)
public/route.js            heurystyka wyboru i kolejności parków
public/data/parks.json     78 punktów (generowane)
public/data/matrix.json    macierz odległości park–park (generowana)
public/vendor/             Leaflet i generator QR (lokalnie)
public/manifest.webmanifest, sw.js, icons/   PWA
server.js                  opcjonalny serwer statyczny do lokalnego podglądu
data/official-parks.json   surowa lista z odkrywca-parkow.pl
data/state.example.json    przykład stanu (bez danych osobowych)
data/state.json            Twoje dane z poprzedniej wersji — ignorowane przez git
tools/import-official.js   przebudowa parks.json
tools/build-matrix.js      przebudowa matrix.json (OSRM)
```

## Aktualizacja punktów

```powershell
# 1. Podmień data/official-parks.json (lub podaj ścieżkę argumentem)
node tools/import-official.js
# 2. Przebuduj macierz, bo zmieniła się liczba/order punktów
node tools/build-matrix.js
# 3. Sprawdź i wypchnij
npm run check   # lub: node --check ...
git add public/data/parks.json public/data/matrix.json
git commit -m "Aktualizacja punktów"
git push
```

Jeśli `matrix.json` nie pasuje do liczby parków, aplikacja sama zbuduje przybliżoną macierz w linii prostej i pokaże odpowiednią informację.

## Licencja i źródła

Kod aplikacji: bez wyraźnej licencji (wszelkie prawa zastrzeżone) — dodaj wybraną licencję, jeśli chcesz go współdzielić.

- punkty i opisy: [odkrywca-parkow.pl](https://odkrywca-parkow.pl) / ZZM Kraków,
- mapa: © OpenStreetMap contributors,
- trasowanie: OSRM / Valhalla (FOSSGIS),
- Leaflet: BSD-2-Clause,
- generator QR: Kazuhiko Arase (MIT).

Aplikacja nie jest powiązana z ZZM ani twórcami strony odkrywca-parkow.pl.
