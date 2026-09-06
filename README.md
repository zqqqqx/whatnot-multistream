# Whatnot Multistream

Du trägst **Streamer** ein, nicht Streams. Die App prüft im Hintergrund alle zwei
Minuten, wer davon gerade live ist, und öffnet die laufende Show automatisch als
Kachel – im Smartphone-Format mit Bild **und** Chat, so wie die Streams gesendet
werden (hochkant, 720×1280). Endet die Show, verschwindet die Kachel wieder.
Ein Klick auf das Vergrößern-Symbol zeigt einen Stream groß in der Desktop-Ansicht – mit Shop,
Produktliste und Gebots-Schaltflächen zum Mitbieten.

Beim ersten Start führt ein kurzer Assistent durch Anmeldung und Streamerliste;
danach läuft alles von allein.

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

### Neue Streams entdecken

Der zweite Reiter im Shows-Fenster zeigt, was gerade auf **deiner** Whatnot-
Startseite läuft – mit Vorschaubild, Verkäufer, Titel und Zuschauerzahl, nach
Zuschauern sortiert. Ein Klick auf eine Karte nimmt den Verkäufer in die Liste
auf; die Kachel erscheint dann von selbst. Wer schon in der Liste steht, ist als
*Schon dabei* gekennzeichnet und lässt sich nicht doppelt aufnehmen.

Gelesen wird über denselben Helfer wie die Live-Erkennung – der liegt ohnehin
angemeldet auf whatnot.com. Beide teilen sich ihn der Reihe nach: Läuft gerade
eine Live-Prüfung, kommt die Startseite erst danach dran, und der Hinweis im
Fenster sagt das auch. Eine einmal geholte Liste gilt anderthalb Minuten als
frisch, *Neu laden* holt sie sofort wieder.

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
| **inkl. Versand** | Klein darunter: was das Los mit Versand zusammen kostet. Erscheint nur, wenn Whatnot beide Beträge wirklich nennt – geschätzt wird nichts. Läuft der Versand bei diesem Verkäufer heute schon, steht dort das Gebot selbst, weil kein zweiter Versand mehr dazukommt. Abschaltbar unter *Einstellungen → Anzeige*. |
| **Countdown** | Restzeit bis zum Hammer. Unter zehn Sekunden wird die Anzeige rot und pocht. |
| **LKW-Symbol** | Bei diesem Verkäufer läuft der Versand heute schon (siehe unten). |

Die Zeile gehört zur App, nicht zur Seite – sie bleibt deshalb auch in kleinen
Kacheln lesbar, statt mitzuschrumpfen. Sie liegt **nicht über** der Seite,
sondern bekommt eigenen Platz unter ihr: Als Überlagerung stand sie zwangsläufig
über Whatnots eigener Bedienung – unten über der Produktkarte und dem gelben
Gebots-Knopf, oben über Name und „Folgen“ –, und zwei Schriften übereinander
liest niemand. Jetzt wird die Seite in der Kachel um diese knapp 30 Pixel kürzer
gezeichnet, und nichts überlappt mehr.

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

Damit die App erkennt, dass **du** den Zuschlag bekommen hast, braucht sie deinen
Whatnot-Usernamen – **eintippen musst du ihn nicht**: Er wird beim Anmelden aus
der Seite gelesen und bleibt gespeichert (siehe *Konto*). Unter *Shows* steht er
dann schon da und lässt sich bei Bedarf überschreiben. Ohne Anmeldung lässt sich
der Merker im Rechtsklick-Menü der Kachel von Hand setzen und wieder entfernen.

## Konto: Anmelden und Namenserkennung

Das Anmelde-Symbol öffnet ein eigenes Fenster direkt bei Whatnot – **dein Passwort
sieht die App nie**. Sie sieht der Seite nur zu und wartet, bis dort ein
angemeldeter Nutzer auftaucht; dann meldet das Fenster kurz *Angemeldet als …*,
schließt sich von selbst, und **alle offenen Streams werden neu geladen**, damit
sie sofort mit dem neuen Konto laufen. Brichst du ab oder schließt das Fenster,
passiert nichts davon – dann wird auch nichts neu geladen.

Erkannt wird der Name an der Stelle, an der Whatnot ihn selbst in jede Seite legt
(`window.__whatnot__.loggerContext.usr.name`), ersatzweise an den
Analyse-Merkmalen im `localStorage`. Das kostet keine eigene Abfrage: Auch bei der
regulären Live-Prüfung fällt der Name nebenbei ab, sodass ein Kontowechsel im
Hintergrund von allein nachgezogen wird. Der Stand steht unter
*Einstellungen → Konto*.

## Ausgeschlossene Konten

Bestimmte Whatnot-Konten können von der Nutzung ausgeschlossen werden. Die Liste
dafür (`banned-users.json`) enthält **keine Klarnamen**, sondern nur den
SHA-256-Abdruck des normalisierten Usernamens – wer die Datei in die Hände
bekommt, erfährt daraus nicht, um wen es geht. Normalisiert wird immer gleich:
Leerraum weg, führendes `@` weg, alles klein; `  @Foo ` und `foo` ergeben also
denselben Abdruck. Einen Abdruck bildet `node tools/ban-hash.js <name>`.

Geprüft wird nach jeder erkannten Anmeldung **und** bei jeder Live-Prüfung. Ein
Treffer legt die App still: keine Kacheln, keine Prüfung, ein Hinweis, dass dieses
Konto nicht zur Nutzung berechtigt ist. Der Vermerk steht in der Ablage, greift
also beim nächsten Start sofort wieder – abmelden, neu starten oder sich erneut
anmelden hilft nicht. Gelöst wird er nur, wenn ein **anderes**, nicht gesperrtes
Konto erkannt wird.

Woher die Liste kommt, steckt allein in `readSources()` in `bans.js`. Soll sie
später aus dem Netz kommen, wird dort eine weitere Quelle eingehängt; der Rest der
App kennt nur `isBanned()` und merkt davon nichts.

## Einrichtung beim ersten Start

Beim allerersten Start führt ein Assistent der Reihe nach durch das, was einmal zu
tun ist: kurze Erklärung, Anmeldung, Bestätigung des erkannten Namens, Streamer
eintragen, das Wichtigste zur Bedienung. Der Fortschritt wird nach jedem Schritt
gemerkt – wer abbricht, macht beim nächsten Start an derselben Stelle weiter, wer
durch ist, sieht ihn nie wieder. Über *Einstellungen → Einrichtung* lässt er sich
jederzeit erneut starten.

Wer die App schon benutzt hat, bekommt ihn nach einer Aktualisierung **nicht**
vorgesetzt: Eine vorhandene Streamerliste gilt als erledigte Einrichtung.

## Einstellungen

Das Schieberegler-Symbol oben öffnet drei Reiter:

| Reiter | Inhalt |
| --- | --- |
| **Allgemein** | Verhalten beim Start (sofort prüfen, Ton der letzten Sitzung wieder aufnehmen), Anzeige (Spaltenzahl, Ansicht der Kacheln, Los-Leiste, Preis inklusive Versand), Maßstab im Raster, Assistent erneut starten. |
| **Konto** | Erkannter Username, Anmeldestatus, anmelden bzw. Konto wechseln. |
| **Updates & Über** | Installierte Version, *Nach Updates suchen* mit verständlicher Antwort, Herunterladen bzw. Neustarten, Link zum Projekt. |

Spaltenzahl und Kachelansicht stehen zugleich in der Kopfleiste – beide Wege
zeigen immer denselben Stand.

## Bedienung

Die Kopfleiste **ist zugleich die Titelleiste**: Die Windows-Leiste mit ihren drei
Knöpfen ist weg, gezogen wird an der App-Leiste selbst, Doppelklick darauf
maximiert und stellt wieder her. Rechts außen sitzen Minimieren,
Maximieren/Wiederherstellen und Schließen im Stil der übrigen Oberfläche; das
mittlere Symbol zeigt, was der Klick tut. An den Fensterkanten lässt sich weiter
ganz normal ziehen.

Links der Zähler, dazwischen die Symbole:

| Element | Funktion |
| --- | --- |
| **Shows** | Streamer hinzufügen, verstecken, entfernen – und im zweiten Reiter entdecken, was gerade auf der Startseite läuft (siehe oben). |
| **Augen-Symbol mit Zahl** | Erscheint, sobald es versteckte Streamer gibt; die Zahl sagt, wie viele davon gerade live sind. Ein Klick zeigt deren Vorschaubilder – ein Klick auf eine Karte holt den Streamer zurück ins Raster. |
| **Spalten** | Rasteraufteilung. „Auto" wählt die Spaltenzahl so, dass das Streambild möglichst groß wird; bei fester Spaltenzahl füllen die Kacheln die Spaltenbreite und das Raster scrollt, wenn es nicht ins Fenster passt. |

Egal wie viele Streams laufen und wie groß das Fenster ist: jede Kachel zeigt die
Seite mit immer derselben logischen Breite, die Kachelgröße bestimmt nur den
Maßstab. Das Verhältnis von Chat zu Videobild bleibt dadurch überall gleich –
bei drei großen Kacheln wird der Chat einfach größer, statt dass Whatnot auf ein
breiteres Layout mit schmalem Chat umschaltet.

Wie breit die Seite gezeichnet wird, stellst du unter *Einstellungen → Maßstab im
Raster* ein. Das ist zugleich der Regler **Video gegen Oberfläche**: Nach links
wird die Seite größer gezeigt – das Videobild füllt mehr Kachel, vom Chat ist
weniger zu sehen. Nach rechts passt mehr Oberfläche hinein und das Bild wird
kleiner. Betroffen ist nur das Raster; die Großansicht läuft immer in
Originalgröße.
| **Sprechblase** | Schaltet **alle** Kacheln gemeinsam im Kreis: ganze Seite → ohne Chat → nur Video. Legt zugleich fest, womit neu auftauchende Kacheln starten. |
| **Sendeturm** | Prüfung sofort starten, statt auf das 2-Minuten-Intervall zu warten. |
| **Lautsprecher / Kreispfeile** | Alle stummschalten bzw. alle Kacheln neu laden. |
| **Anmelde-Symbol** | Öffnet das Anmeldefenster. Nach erfolgreicher Anmeldung schließt es sich von selbst und alle Streams werden neu geladen (siehe *Konto*). Leuchtet gelb, solange ein Konto erkannt ist. |
| **Schieberegler** | Einstellungen: Allgemein, Konto, Updates & Über. |

Je Kachel, in der Kopfzeile (erscheint beim Überfahren):

| Symbol | Funktion |
| --- | --- |
| **Lautsprecher** | Ton läuft immer nur auf einer Kachel – Klick schaltet dorthin um. |
| **Sprechblase** | Schaltet die Ansicht im Kreis: **ganze Seite** → **ohne Chat** (Shop, Preis und Gebots-Schaltflächen bleiben) → **nur Video**. Das Rechtsklick-Menü hat beide Schritte auch einzeln. Gilt nur fürs Raster – in der Großansicht ist der Knopf deshalb ausgeblendet. |
| **Pfeil aus dem Kasten** | Diese Show im richtigen Browser öffnen. |
| **Vergrößern / Verkleinern** | Großansicht: Kachel füllt das Fenster in **Originalgröße und Desktop-Layout** – Shop, Produkte und Gebote sind bedienbar. Dort sind Chat und Oberfläche **immer da**, unabhängig davon, was im Raster eingestellt ist; beim Verkleinern kommt genau der Rasterzustand zurück (Chat im Raster ausgeblendet → in der Großansicht sichtbar → danach wieder ausgeblendet). Beim Vergrößern läuft der Ton dieser Show, beim Verkleinern wieder der Zustand von vorher. Verkleinern geht auch mit Esc. |
| **Kreispfeil** | Show neu laden. |

Weitere Griffe:

| Aktion | Funktion |
| --- | --- |
| **Rechtsklick auf eine Kachel** | Menü mit *Groß anzeigen*, *Nur Video zeigen*, *Im Browser öffnen*, *Versand läuft heute schon*, *Neu laden*, *User verstecken* und *User entfernen*. |
| **Rechtsklick halten und ziehen** | Kacheln umsortieren. Die Streams laufen dabei weiter – die Reihenfolge wird nur über CSS gesetzt, die Kacheln werden nicht neu geladen. |

Solange keine Kachel läuft, zeigt die Bühne, woran die App gerade ist: beim Start
ein Radar mit dem Namen des Profils, das gerade geprüft wird, danach entweder die
laufenden Shows oder die Meldung, dass niemand sendet (mit Hinweis, falls nur
versteckte Streamer live sind).

Cookie-Banner werden in jeder Kachel automatisch mit „Nur notwendige" geschlossen;
dafür gibt es bewusst keinen Schalter mehr.

Ebenfalls automatisch weg ist Whatnots Einblendung *„Du nimmst jetzt an … Stream
teil"*: Bei einer Wand aus Kacheln erscheint sie reihum in jeder einzelnen und
verdeckt jedes Mal ein Stück Bild. Ausgeblendet wird **nur diese eine Meldung**,
erkannt am Wortlaut (deutsch und englisch) – Fehlermeldungen, Gebotshinweise und
alles andere bleiben stehen.

### Wo die Liste liegt

Streamerliste, Einstellungen und Versand-Merker stehen als eigene Datei
`wnms-store.json` im Datenordner der App (`%APPDATA%\whatnot-multistream`).
Früher lagen sie im `localStorage` des Fensters – und das benutzt dieselbe
Ablage-Partition wie die Streams selbst, die Liste stand also mitten in mehreren
hundert Megabyte Whatnot-Daten. Wird davon etwas verworfen, war sie weg.

Geschrieben wird über eine Nebendatei, die anschließend in einem Zug an ihren
Platz gezogen wird: Ein Absturz mitten im Schreiben kann so keine halbe Datei
hinterlassen. Die vorige Fassung bleibt als `.bak` liegen; ist die Hauptdatei
unbrauchbar, wird daraus gelesen **und sie sofort wiederhergestellt**. Zur
Sicherung befördert wird immer nur eine Datei, die sich auch lesen lässt.

Darin steht alles, was du einstellst, und es steht beim nächsten Start wieder da:

| Was | Wo es hängt |
| --- | --- |
| Streamerliste, versteckt-Markierung | je Streamer |
| **Reihenfolge der Kacheln** | die Reihenfolge der Liste – beim Umsortieren per Rechtsklick-Ziehen mitgeschrieben |
| **Ansicht je Kachel** (ganze Seite / ohne Chat / nur Video) | je Streamer, gilt auch nach einem Neuaufbau der Kachel |
| Ansicht für alle, Spaltenzahl, eigener Username | allgemeine Einstellungen |
| **Erkanntes Konto und Sperrvermerk** | schreibt der Hauptprozess, nicht das Fenster |
| **Fortschritt der Einrichtung** | Schritt und ob sie abgeschlossen ist |
| **Alle Schalter der Einstellungen** | Startverhalten, Los-Leiste, Preis inklusive Versand, Maßstab im Raster |
| **Welcher Stream Ton hat** | wird wieder aufgenommen, sobald die Kachel da ist |
| **Fenstergröße, -lage und Vollbild** | wird beim Verschieben gemerkt |
| Versand-Merker | je Streamer, gilt für den laufenden Tag |

Ein vorangestelltes Byte-Order-Mark – etwa weil die Datei mit einem Editor
angefasst wurde – wird beim Lesen abgestreift, statt die Ablage fälschlich für
beschädigt zu halten.

Fenster und Hauptprozess schreiben in dieselbe Datei, aber jeder nur **seine
eigenen** Einträge: Das Fenster gibt ausschließlich das weiter, was es selbst
geändert hat. Gäbe es stattdessen jedes Mal seine ganze Abschrift vom
Programmstart heraus, schriebe es Fenstergröße, erkanntes Konto und Sperrvermerk
auf den Stand von vorhin zurück.

Die gemerkte Fensterlage wird beim Start nur übernommen, wenn dort auch wirklich
ein Bildschirm ist – sonst startet die App unsichtbar, etwa weil der zweite
Monitor abgesteckt wurde.

Die App läuft außerdem nur noch einmal gleichzeitig – ein zweiter Start holt das
vorhandene Fenster nach vorn, statt sich mit ihm um dieselbe Datei zu streiten.

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

## Grenzen

- **Ohne Login** zeigt Whatnot in jeder Kachel ein Anmelde-Fenster über dem Stream.
  Einmal über das Anmelde-Symbol oben anmelden, dann ist es weg.
- **20 gleichzeitige Streams sind viel Last** (jede Kachel ist ein eigener
  Browser-Prozess mit laufendem Video). Bei ruckelnden Bildern: Streamer
  verstecken – versteckte Kacheln laufen gar nicht erst mit.
- **Bis zu zwei Minuten Verzögerung**: geht ein Streamer live, erscheint die
  Kachel erst bei der nächsten Prüfung. Der Sendeturm oben rechts holt sie sofort.
- Ändert Whatnot Seitenaufbau und Datenformat gleichzeitig, fällt die
  Live-Erkennung aus. In der Shows-Liste steht dann *Prüfung fehlgeschlagen*
  mit dem Grund.
