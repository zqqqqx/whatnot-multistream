# Whatnot Multistream

Du trägst **Streamer** ein, nicht Streams. Die App prüft im Hintergrund alle zwei
Minuten, wer davon gerade live ist, und öffnet die laufende Show automatisch als
Kachel – im Smartphone-Format mit Bild **und** Chat, so wie die Streams gesendet
werden (hochkant, 720×1280). Endet die Show, verschwindet die Kachel wieder.
Ein Klick auf das Vergrößern-Symbol zeigt einen Stream groß in der Desktop-Ansicht – mit Shop,
Produktliste und Gebots-Schaltflächen zum Mitbieten.

## Installieren

Im Ordner `dist` liegt **`Whatnot-Multistream-Setup-<version>.exe`**. Doppelklick,
Zielordner wählen, fertig – die Installation läuft ohne Administratorrechte
(nur für den angemeldeten Benutzer) und legt Verknüpfungen auf dem Desktop und
im Startmenü an. Deinstalliert wird über *Apps & Features*.

Da die Datei nicht signiert ist, meldet sich beim ersten Start der
SmartScreen-Filter von Windows: *Weitere Informationen* → *Trotzdem ausführen*.

## Aktualisierungen

Die App sieht bei GitHub nach, ob eine neuere Fassung vorliegt – acht Sekunden
nach dem Start und danach alle drei Stunden. Geladen wird **nichts von allein**:
Gibt es etwas Neues, erscheint oben in der Kopfleiste ein gelber Knopf
*„Version x.y.z laden"*. Ein Klick lädt herunter (der Knopf füllt sich als
Fortschrittsbalken), ein zweiter startet die App neu und spielt die Fassung ein.
Wer stattdessen einfach schließt, bekommt sie beim nächsten Beenden eingespielt.

Steht nichts an, ist von alldem nichts zu sehen.

Bezugsquelle sind die [Releases](https://github.com/zqqqqx/whatnot-multistream/releases)
dieses Projekts. Dort liegen je Fassung drei Dateien: der Installer, eine
`latest.yml` mit Version und Prüfsumme und eine `.blockmap`, dank der nur die
geänderten Teile geladen werden statt jedes Mal 112 MB. Weil der Installer nicht
signiert ist, meldet sich beim Einspielen wieder SmartScreen.

## Aus dem Quelltext starten

Doppelklick auf **`Whatnot Multistream starten.bat`** – oder im Ordner:

```bash
npm start
```

Die installierte Fassung und `npm start` teilen sich denselben Datenordner, die
Streamerliste ist also in beiden dieselbe.

## Installer neu bauen

```bash
npm run dist
```

Das erzeugt zuerst aus `build/icon.svg` die Symbole (`npm run icon`) und packt
dann mit electron-builder den NSIS-Installer nach `dist/` – zusammen mit
`latest.yml` und `.blockmap`. Für eine neue Fassung: Version in der
`package.json` erhöhen, bauen und **alle drei Dateien** an ein GitHub-Release
mit dem Tag `v<version>` hängen. Genau danach sucht die Selbstaktualisierung. Das App-Symbol ist
dasselbe gelbe Abzeichen mit dem **W**, das oben links in der App steht.

## Warum eine Desktop-App und keine Webseite?

Whatnot verbietet das Einbetten seiner Seiten per iFrame
(`X-Frame-Options: SAMEORIGIN`). Im Browser lässt sich deshalb keine Seite bauen,
die mehrere Streams gleichzeitig anzeigt. Diese App bettet die Streams nicht als
iFrames ein, sondern als eigenständige Browser-Views (Electron `<webview>`) –
dafür gilt die Sperre nicht. Ergebnis: alles läuft in einem Fenster.

## Streamer verwalten

Der Knopf **Shows** öffnet die Liste. Jede Zeile zeigt das Profilbild, den
Namen, ein **LIVE**-Zeichen, wenn gerade gesendet wird, und darunter Zuschauer
und Showtitel – sonst *Offline* mit dem Termin der nächsten geplanten Show.
Rechts liegen drei Schalter: Profil im Browser öffnen, verstecken und entfernen.

**Verstecken** heißt: Der Streamer wird weiter geprüft, bekommt aber nie eine
Kachel. Geht er live, erscheint er oben hinter dem Augen-Symbol. Praktisch für
Kanäle, die man beobachten, aber nicht dauernd sehen will.

### Ganze Listen einfügen und weitergeben

Ins Eingabefeld darf auch eine **ganze Liste**:

```
voltico, emd_livedeals, soleva7
```

Getrennt wird an Komma, Semikolon, Leerzeichen und Zeilenumbruch; `@name` und
ganze Profil-Links gehen ebenso. Namen, die schon in der Liste stehen, werden
stillschweigend übersprungen – die Meldung sagt hinterher, was hinzugekommen ist
und was schon dabei war.

Umgekehrt gibt **Liste kopieren** unten alle Streamer im selben Format in die
Zwischenablage. So lässt sich die eigene Auswahl an Freunde weitergeben, die sie
in einem Zug einfügen können.

Bis zu 40 Streamer lassen sich beobachten; gleichzeitig laufen höchstens
20 Kacheln. Profilbilder holt die App bei der Live-Prüfung mit und merkt sie
sich, damit sie beim nächsten Start sofort da sind.

## Wie die Live-Erkennung funktioniert

Eine Profilseite listet unter „Anstehende Shows" die laufende **und** die nur
geplanten Shows nebeneinander auf – der Link allein sagt also nichts darüber aus,
ob gerade gesendet wird. Die App holt deshalb die Profilseite und liest den
Status der einzelnen Shows aus den mitgelieferten Seitendaten:

- `PLAYING` → läuft gerade, diese Show wird geöffnet
- `CREATED` → nur geplant, wird ignoriert

Fällt dieser Weg aus (z. B. weil Whatnot den Seitenaufbau ändert), lädt die App
das Profil sichtbar nach und erkennt die laufende Show am roten
**„Live · *n*"**-Aufkleber der Show-Kachel.

Geprüft wird alle zwei Minuten – für alle Streamer nacheinander, damit Whatnot
nicht mit Anfragen überschüttet wird. Dabei wird auch geprüft, ob die gerade
angezeigte Show **noch** dieselbe und **noch** live ist: Ist der Streamer offline,
verschwindet die Kachel; hat er inzwischen eine neue Show gestartet, wechselt die
Kachel auf den neuen Link.

Die Prüfung läuft in einem unsichtbaren Whatnot-Fenster im Hintergrund – dadurch
gelten Anmeldung und Herkunft wie bei einem normalen Besuch der Seite.

## Was gerade unter dem Hammer ist

Am unteren Rand jeder Kachel läuft eine schmale Zeile mit dem aktuellen Los:

| Teil | Bedeutung |
| --- | --- |
| **Titel** | Das Los, das gerade läuft – inklusive Losnummer, z. B. *Amazon A/B Ware #78*. |
| **Betrag** | Was das **nächste** Gebot kosten würde. Liegst du selbst vorn, wird der Betrag grün. |
| **Countdown** | Restzeit bis zum Hammer. Unter zehn Sekunden wird die Anzeige rot und pocht. |
| **LKW-Symbol** | Bei diesem Verkäufer läuft der Versand heute schon (siehe unten). |

Die Zeile gehört zur App, nicht zur Seite – sie bleibt deshalb auch in kleinen
Kacheln lesbar, statt mitzuschrumpfen, und sie schluckt keine Klicks: Whatnots
eigene Bedienung darunter bleibt erreichbar.

Gelesen wird direkt in der Kachel, im Takt von 0,7 Sekunden, und gemeldet wird
nur, wenn sich etwas geändert hat. Die Show-Oberfläche hat dafür benannte
Haltepunkte (`show-product-title`, `show-timer`, `show-bid-button`,
`show-winning-status`, `show-winner-message`, `show-shipping-info`); ändert
Whatnot deren Namen, bleibt die Zeile leer, alles andere läuft weiter.

## Versand-Bündelung

Whatnot fasst den Versand pro Verkäufer und Tag zusammen: Hast du bei einem
Verkäufer heute schon etwas ersteigert, kostet das nächste Los dort **keinen
zweiten Versand**. Beim Vergleich zweier Kacheln übersieht man das leicht – das
gleiche Teil ist beim „teureren" Verkäufer unterm Strich womöglich günstiger.

Die App merkt sich deshalb, wo heute schon ein Zuschlag gefallen ist, und setzt
auf diese Kachel ein LKW-Symbol (mit Anzahl, wenn es mehrere Lose waren). Der
Hinweistext nennt auch die Versandkosten des Verkäufers, so wie die Show sie
angibt. Am nächsten Tag verfällt der Merker von selbst.

Damit die App erkennt, dass **du** den Zuschlag bekommen hast, trägst du unter
*Shows* deinen eigenen Whatnot-Usernamen ein – mit *Speichern*, Eingabetaste oder
einfach durch Verlassen des Feldes; eine kurze Rückmeldung bestätigt es. Ohne
diesen Eintrag lässt sich der Merker im Rechtsklick-Menü der Kachel von Hand
setzen und wieder entfernen.

## Bedienung

Die Kopfleiste hält nur noch das Nötigste: links der Zähler, rechts Symbole.

| Element | Funktion |
| --- | --- |
| **Shows** | Streamer hinzufügen, verstecken, entfernen (siehe oben). |
| **Augen-Symbol mit Zahl** | Erscheint, sobald es versteckte Streamer gibt; die Zahl sagt, wie viele davon gerade live sind. Ein Klick zeigt deren Vorschaubilder – ein Klick auf eine Karte holt den Streamer zurück ins Raster. |
| **Spalten** | Rasteraufteilung. „Auto" wählt die Spaltenzahl so, dass das Streambild möglichst groß wird; bei fester Spaltenzahl füllen die Kacheln die Spaltenbreite und das Raster scrollt, wenn es nicht ins Fenster passt. |

Egal wie viele Streams laufen und wie groß das Fenster ist: jede Kachel zeigt die
Seite mit immer derselben logischen Breite (400 px), die Kachelgröße bestimmt nur
den Maßstab. Das Verhältnis von Chat zu Videobild bleibt dadurch überall gleich –
bei drei großen Kacheln wird der Chat einfach größer, statt dass Whatnot auf ein
breiteres Layout mit schmalem Chat umschaltet.
| **Sendeturm** | Prüfung sofort starten, statt auf das 2-Minuten-Intervall zu warten. |
| **Lautsprecher / Kreispfeile** | Alle stummschalten bzw. alle Kacheln neu laden. |
| **Anmelde-Symbol** | Öffnet Whatnot in einem Extra-Fenster. Einmal anmelden – die Anmeldung gilt für alle Kacheln und bleibt gespeichert. |

Je Kachel, in der Kopfzeile (erscheint beim Überfahren):

| Symbol | Funktion |
| --- | --- |
| **Lautsprecher** | Ton läuft immer nur auf einer Kachel – Klick schaltet dorthin um. |
| **Sprechblase** | Schaltet die Ansicht im Kreis: **ganze Seite** → **ohne Chat** (Shop, Preis und Gebots-Schaltflächen bleiben) → **nur Video**. Das Rechtsklick-Menü hat beide Schritte auch einzeln. |
| **Pfeil aus dem Kasten** | Diese Show im richtigen Browser öffnen. |
| **Vergrößern / Verkleinern** | Fokus: Kachel füllt das Fenster in **Originalgröße und Desktop-Layout** – Shop, Produkte und Gebote sind bedienbar. Beim Vergrößern läuft der Ton dieser Show, beim Verkleinern wieder der Zustand von vorher. Verkleinern geht auch mit Esc. |
| **Kreispfeil** | Show neu laden. |

Weitere Griffe:

| Aktion | Funktion |
| --- | --- |
| **Strg halten (im großen Modus)** | Lupe: ein Glas folgt dem Zeiger und zeigt den Ausschnitt darunter vergrößert. **Mausrad** ändert die Größe des Glases, **Umschalt + Mausrad** die Vergrößerung (1,5× bis 8×). Loslassen blendet die Lupe wieder aus. |
| **Rechtsklick auf eine Kachel** | Menü mit *Groß anzeigen*, *Nur Video zeigen*, *Im Browser öffnen*, *Versand läuft heute schon*, *Neu laden*, *User verstecken* und *User entfernen*. |
| **Rechtsklick halten und ziehen** | Kacheln umsortieren. Die Streams laufen dabei weiter – die Reihenfolge wird nur über CSS gesetzt, die Kacheln werden nicht neu geladen. |

Solange keine Kachel läuft, zeigt die Bühne, woran die App gerade ist: beim Start
ein Radar mit dem Namen des Profils, das gerade geprüft wird, danach entweder die
laufenden Shows oder die Meldung, dass niemand sendet (mit Hinweis, falls nur
versteckte Streamer live sind).

Cookie-Banner werden in jeder Kachel automatisch mit „Nur notwendige" geschlossen;
dafür gibt es bewusst keinen Schalter mehr.

Streamerliste und Einstellungen bleiben nach dem Schließen erhalten. Eine
vorhandene alte Stream-Liste wird beim ersten Start übernommen: aus jeder
Profil-Kachel wird ein Streamer, direkte Live-Links entfallen (sie lassen sich
keinem Namen zuordnen).

### Wie der Wechsel in den großen Modus abläuft

Beim Vergrößern ändert sich zweierlei gleichzeitig: die Kachel wird zur ganzen
Bühne, und die Seite läuft ab jetzt in Originalgröße statt verkleinert. Whatnot
baut daraufhin sein Layout um – vom Handy-Format mit Chat unter dem Bild auf die
Desktop-Ansicht. Dieser Umbau dauert ein paar Bilder und sieht roh aus.

Er passiert deshalb hinter einem Standbild: Von der Kachel wird ein Bild
gezogen, das sich genau über sie legt und in die neue Größe fährt – erst wenn
die Seite darunter meldet, dass sie fertig ist, blendet es weg. Zu sehen ist
nur eine Kachel, die wächst bzw. schrumpft.

Verdeckt wird dabei **nur die eine Kachel**, nicht das ganze Fenster: Beim
Verkleinern sind die übrigen Streams sofort wieder da, auch wenn die große
Kachel noch ein, zwei Sekunden braucht. Die anderen Kacheln werden im großen
Modus auch nicht ausgeblendet, sondern nur unsichtbar zur Seite gelegt – in
ihrer bisherigen Größe. So bauen sie ihr Layout nicht um und bleiben gezeichnet,
statt beim Zurückschalten erst sekundenlang schwarz zu sein.

Wann die Seite fertig ist, sagt sie selbst: Ein fester Zeitwert trifft es nie,
weil Whatnot beim Wechsel zwischen Handy- und Desktop-Ansicht andere Bilder
nachlädt und das Video neu einhängt. Die Kachel meldet sich deshalb erst, wenn
sich ihr Layout mehrere Proben lang nicht mehr bewegt **und** das Video wieder
läuft. Dauert das länger, zeigt der Deckel nach einer knappen halben Sekunde
einen kleinen Puffer, damit die Wartezeit nicht wie ein Hänger aussieht.
Spätestens nach 2,6 Sekunden geht es ohnehin weiter.

Sind die Windows-Animationseffekte abgeschaltet (*Einstellungen → Barrierefreiheit
→ Visuelle Effekte*), entfällt nur die Fahrt in die neue Größe – der Deckel
bleibt, der Umbau ist also weiterhin nicht zu sehen.

### Wie die Lupe technisch geht

Eine Kachel ist ein eigenständiger Browser-View – ihr Inhalt lässt sich vom
App-Fenster aus nicht einfach vergrößert nachzeichnen. Die Lupe fotografiert
deshalb zehnmal pro Sekunde genau den Ausschnitt unter dem Glas ab
(`capturePage` mit Rechteck, nicht die ganze Seite) und setzt ihn vergrößert ein.

## Grenzen

- **Ohne Login** zeigt Whatnot in jeder Kachel ein Anmelde-Fenster über dem Stream.
  Einmal über das Anmelde-Symbol oben rechts anmelden, dann ist es weg.
- **20 gleichzeitige Streams sind viel Last** (jede Kachel ist ein eigener
  Browser-Prozess mit laufendem Video). Bei ruckelnden Bildern: Streamer
  verstecken – versteckte Kacheln laufen gar nicht erst mit.
- **Bis zu zwei Minuten Verzögerung**: geht ein Streamer live, erscheint die
  Kachel erst bei der nächsten Prüfung. Der Sendeturm oben rechts holt sie sofort.
- Ändert Whatnot Seitenaufbau und Datenformat gleichzeitig, fällt die
  Live-Erkennung aus. In der Shows-Liste steht dann *Prüfung fehlgeschlagen*
  mit dem Grund.
