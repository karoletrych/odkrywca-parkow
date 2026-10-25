# Odkrywca krakowskich parków

Lokalna aplikacja webowa: mapa 78 punktów z odznaki **Odkrywca Krakowskich Parków**, dziennik odwiedzin i planer dziennej trasy pieszej.

- punkty i kategorie pochodzą z [odkrywca-parkow.pl](https://odkrywca-parkow.pl) (dane ZZM Kraków),
- „zrobione” i zapisane trasy trzymane są na Twoim dysku (`data/state.json`),
- trasę można ułożyć od dowolnego startu, dla wybranej liczby parków, a długość liczona jest po pieszych szlakach z OpenStreetMap.

## Uruchomienie

Najprościej: serwer jest już zarejestrowany jako zadanie systemowe **OdkrywcaParkow** i startuje w tle przy logowaniu. Aplikacja jest pod `http://localhost:7777`.

Sterowanie serwerem w tle (PowerShell):

```powershell
Start-ScheduledTask -TaskName "OdkrywcaParkow"   # uruchom
Stop-ScheduledTask  -TaskName "OdkrywcaParkow"   # zatrzymaj
Get-ScheduledTask   -TaskName "OdkrywcaParkow"   # status
```

Ręcznie: dwuklik `start.cmd` (otwiera przeglądarkę) albo `node server.js`. Logi trafiają do `data/server.log`.

## Telefon i VPN

- W aplikacji kliknij ikonę telefonu w prawym górnym rogu — pokaże gotowe adresy (sieć lokalna i VPN) z przyciskiem „Kopiuj”.
- Ta sama sieć Wi-Fi: `http://<adres-LAN>:7777` (adres wypisuje też konsola).
- VPN Tailscale (działa z dowolnej sieci):
  1. Tailscale na telefonie i komputerze, to samo konto,
  2. na komputerze: `tailscale serve --bg 7777`,
  3. `tailscale serve status` pokaże adres HTTPS, np. `https://pc.tailxxxx.ts.net/`.
- Serwer nasłuchuje na `0.0.0.0`, więc działa przez VPN i sieć lokalną. Windows może poprosić o zgodę zapory — zezwól Node.js w sieci prywatnej.
- Gdy router włącza izolację klientów (AP isolation), sam LAN nie zadziała — użyj Tailscale.

## Obsługa

- **Start** — domyślnie Rynek Główny. Możesz kliknąć „Wskaż start na mapie”, przeciągnąć pinezkę **A**, użyć „Moja lokalizacja” albo w dymku parku wybrać „Ustaw jako start”.
- **Parki na dziś** — liczba zmieniana przez `−` / `+`, suwak, kafelki (3/5/7/10/15) lub klawisze `+` / `-`. Trasa przelicza się od razu. Pod przyciskami widać, ile kilometrów doda (lub odejmie) zmiana o −1, +1, +2, +3 i +4 parki — kliknięcie od razu ustawia tę liczbę.
- **Co liczyć** — kategorie (historyczne, wodne, leśne, zwykłe), pomijanie już zrobionych, opcja powrotu do startu.
- **Zrobione** — przycisk w dymku parku (z datą) albo checkbox na liście „Parki”. Postęp zapisuje się automatycznie.
- **Zapisz** — zapisuje aktualną trasę w zakładce „Zapisane”; można ją później pokazać na mapie lub usunąć.
- **Pobierz GPX / Nawiguj** — GPX z całą trasą i punktami otworzysz w OsmAnd, Locus Map, Komoot, Garminie itp. „Nawiguj” otwiera Google Maps (do 10 punktów; pełna trasa jest w GPX). Zapisane trasy też mają przycisk GPX.
- Kliknięcie przystanku na liście przybliża go na mapie. `Esc` zamyka dymek / anuluje wskazywanie startu.

Kolory pinezek odpowiadają kategoriom z odznaki: czerwony — historyczny, niebieski — wodny, zielony — leśny, czarny — zwykły.

## Eksport trasy

- **GPX** zawiera waypointy wszystkich parków (nazwa, numer, kategoria, wskazówka o pieczątce) oraz ślad trasy po pieszych ścieżkach — do importu w OsmAnd, Locus Map, Komoot, Garmin Connect, Wikiloc itd.
- **Google Maps** — link „Nawiguj” prowadzi do trasy pieszej przez wszystkie punkty, ale Google Maps przyjmie maks. 10 punktów. Dla dłuższych tras użyj GPX.
- Pliki GPX generowane są lokalnie w przeglądarce; nic nie jest wysyłane na zewnątrz.

## Jak liczona jest trasa

- Odległości piesze pobierane są z publicznych usług OSM (Valhalla dla dojścia ze startu, OSRM dla macierzy park–park) i zapisywane w `data/matrix.json`.
- Dobór parków i kolejność: wstawianie najmniejszym kosztem + poprawa 2-opt + wymiana przystanków. To heurystyka — daje bardzo dobre, ale nie zawsze formalnie optymalne rozwiązanie.
- Czas pieszo szacowany jest na podstawie dystansu (ok. 4,8 km/h).
- Gdy usługa tras jest chwilowo niedostępna, część odległości liczona jest w linii prostej (aplikacja to sygnalizuje).

## Dane i pliki

```
server.js              serwer HTTP (bez zależności), API, kafelki mapy z cache
public/                interfejs (Leaflet vendored lokalnie)
data/parks.json        punkty parków (generowane z official-parks.json)
data/official-parks.json  surowa lista z odkrywca-parkow.pl
data/state.json        Twoje odwiedzone parki, zapisane trasy, ustawienia
data/matrix.json       cache macierzy odległości
data/tiles/            cache kafelków OpenStreetMap
data/server.log        log serwera (rotowany przy 2 MB)
start.cmd              ręczne uruchomienie w oknie
start-background.vbs   uruchomienie bez okna (używane przez zadanie)
```

`data/state.json` zawiera Twoje odwiedzone parki, zapisane trasy i ustawienia — jest ignorowany w repozytorium (wzór: `data/state.example.json`). Kafelki i macierz odległości też są lokalnym cache'em.

Aktualizacja listy punktów: podmień `data/official-parks.json` i uruchom `node tools/import-official.js`, następnie usuń `data/matrix.json` (macierz przeliczy się przy starcie).

## Uwagi

- Pierwsze uruchomienie może potrwać kilkanaście sekund — liczona jest macierz odległości (potem jest cache).
- Kafelki mapy są pobierane z OpenStreetMap i cache’owane lokalnie; bez internetu zadziała to, co już zostało pobrane.
- Publiczne serwery tras OSM mają limity — przy normalnym, domowym użyciu wystarczają.
- Aplikacja nie jest powiązana z ZZM ani twórcami strony odkrywca-parkow.pl.

Źródła: punkty — odkrywca-parkow.pl / ZZM Kraków; mapa — © OpenStreetMap; trasowanie — OSRM / Valhalla (FOSSGIS).
