# Að setja ChessGUI upp á Windows- eða Linux-tölvu

English version: [pc-install.md](pc-install.md)

Leiðbeiningar á mannamáli fyrir PC-útgáfurnar (verklýsing 222). Þessar
útgáfur eru **óundirritaðar** — það er meðvituð ákvörðun fyrir forrit sem
er eingöngu notað innan fjölskyldunnar, og það þýðir að Windows birtir
eina viðvörun við uppsetningu. Sú viðvörun er eðlileg og óhætt að smella
sig í gegnum hana; skrefin hér að neðan sýna nákvæmlega hvar.

## Windows

1. **Sæktu** uppsetningarskrána úr nýjustu útgáfunni á
   <https://github.com/hthor213/chessgui/releases> — veldu skrána sem endar á
   `.msi` (eða `-setup.exe` ef þér líkar það betur).
2. **Keyrðu hana.** Windows SmartScreen birtir þá bláan glugga sem segir
   *„Windows protected your PC“* („Windows varði tölvuna þína“). Hann
   birtist af því að forritið er ekki með rafræna undirskrift — ekki af
   því að neitt sé að.
3. Smelltu á **„More info“** („Nánari upplýsingar“ — lítill tengill í
   textanum).
4. Smelltu á **„Run anyway“** („Keyra samt“).
5. Fylgdu svo uppsetningarforritinu. Þá er þetta komið — ChessGUI birtist
   í Start-valmyndinni.

Skákvélin (Stockfish) fylgir með inni í forritinu; það þarf ekkert annað
að sækja. (Til stendur að forritið mæli hraða tölvunnar sjálfkrafa í
fyrsta skipti sem það er ræst, en sú mæling er ekki tilbúin enn — þangað
til eru styrkleikamerkingar forritsins áætlaðar tölur, ekki mældar fyrir
þessa tilteknu tölvu.)

### Ef skákvélin fer ekki í gang

Á tölvum eldri en frá um það bil 2013 getur verið að meðfylgjandi skákvél
neiti að keyra (örgjörvann vantar skipanasett sem heitir AVX2). Forritið
lætur þig vita á mannamáli ef það gerist. Lausnin: sæktu Stockfish-útgáfu
sem passar við örgjörvann þinn á <https://stockfishchess.org/download/>
(veldu útgáfu án AVX2, t.d. „x86-64-sse41-popcnt“), opnaðu síðan
**Engine settings (tannhjólið) → Browse…** í ChessGUI og veldu
`stockfish.exe`-skrána sem þú sóttir.

## Linux

Krefst Ubuntu 22.04+ eða álíka nýlegrar dreifingar (webkit2gtk 4.1).

- **AppImage** (einfaldast, keyrir hvar sem er):

  ```bash
  chmod +x ChessGUI_*.AppImage
  ./ChessGUI_*.AppImage
  ```

- **Debian/Ubuntu-pakki**:

  ```bash
  sudo apt install ./ChessGUI_*.deb
  ```

Meðfylgjandi skákvélin virkar eins og á Windows, og sama neyðarleið gildir
ef örgjörvinn ræður ekki við AVX2 (Engine settings → Browse…).
