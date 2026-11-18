# Vergaderruimtes

Dit is een reserveringssite voor vergaderruimtes. Alleen projectdeelnemers die de beheerder heeft uitgenodigd kunnen inloggen. Dat doen ze met hun e-mailadres, zonder wachtwoord.

- **Website**: `index.html`, gehost op GitHub Pages
- **Database en login**: Supabase-project `vergaderruimtes` (eu-central-1)
- **Ruimte uitnodigen via Outlook**: elke ruimte heeft een eigen adres, bijvoorbeeld `vergaderruimtes.smh+keet@gmail.com`. Een Google Apps Script controleert de mailbox elke minuut. Het script boekt de uitnodiging en stuurt een acceptatie of weigering terug.

## Wat de site kan

- Inloggen: de eerste keer met een link per mail, daarna met e-mailadres en wachtwoord. Het wachtwoord stel je in via *Wachtwoord* rechtsboven.

- *Toegang aanvragen*: wie geen toegang heeft, vraagt die aan op het inlogscherm. Beheerders krijgen een mail en keuren goed of af onder *Beheer*. Bij goedkeuring krijgt de aanvrager automatisch een mail. Afgewezen aanvragen worden direct verwijderd, openstaande na 30 dagen.
- Dagplanning per ruimte: klik op een vrij tijdslot om te reserveren. Dubbele boekingen zijn onmogelijk, dat bewaakt de database zelf.
- *Mijn reserveringen*: je eigen boekingen wijzigen of verwijderen.
- *Ruimtes*: de e-mailadressen om de ruimtes in Outlook uit te nodigen.
- *Beheer* (alleen voor beheerders): deelnemers toevoegen of verwijderen, ruimtes beheren en het Gmail-adres instellen.
- *Agenda-abonnement*: elke deelnemer krijgt onder *Ruimtes* een persoonlijke iCal-link voor alle ruimtes of één ruimte. Die voeg je toe in Outlook, Google Agenda of op je iPhone. De link wordt geserveerd door de Edge Function `agenda`.
- *Scherm-modus* (`?scherm=1`): laat op een scherm in de keet per ruimte zien of die vrij of bezet is.

## Privacy (AVG)

- **Inloggen alleen met een link per mail.** Wachtwoorden zijn uitgeschakeld en worden ook aan de serverkant geblokkeerd.
- **Deelnemers zien elkaars gegevens niet.** Bij een reservering staat alleen de naam van de organisator. E-mailadressen, bedrijven en de deelnemerslijst ziet alleen een beheerder.
- **Andere genodigden worden nergens opgeslagen.** Van een Outlook-uitnodiging bewaart het systeem alleen onderwerp, tijd, ruimte en organisator. Na verwerking gaat de mail direct naar de prullenbak van het ruimte-Gmailaccount en verdwijnt daar na 30 dagen.
- **Bewaartermijnen:**
  - reserveringen worden 3 maanden na afloop automatisch verwijderd, elke nacht om 03:15
  - verwijder je een deelnemer, dan verdwijnen ook direct diens inlogaccount en agenda-link
  - in Gmail gaan verzonden mails (inloglinks, acceptaties en weigeringen) na 30 dagen naar de prullenbak, en Gmail wist de prullenbak zelf na 30 dagen
- **Mails uit het systeem** (weigeringen, agenda-feed) noemen bij een botsing alleen de naam van de organisator.

## Eenmalige installatie

### 1. Gmail-account voor de ruimtes
1. Maak een Gmail-account aan, bijvoorbeeld `vergaderruimtes.smh@gmail.com`. Kies je een ander adres, pas het dan aan in *Beheer → Instellingen*.
2. Zet tweestapsverificatie aan en maak een **app-wachtwoord** aan: Google-account → Beveiliging → App-wachtwoorden. Dit heb je nodig in stap 2.

### 2. Supabase-instellingen (dashboard → project `vergaderruimtes`)
1. Ga naar **Authentication → Emails → SMTP Settings** en zet *Custom SMTP* aan:
   - Host `smtp.gmail.com`, poort `465`
   - Gebruiker: het Gmail-adres, wachtwoord: het app-wachtwoord
   - Afzender: het Gmail-adres, naam: `Vergaderruimtes`

   Dit is nodig omdat Supabase zelf alleen inlogmails stuurt naar leden van je Supabase-team.
2. Ga naar **Authentication → URL Configuration**:
   - *Site URL*: `https://<jouw-github-naam>.github.io/vergaderruimtes/`
   - Zet hetzelfde adres ook bij *Redirect URLs*.
3. Optioneel: ga naar **Authentication → Emails → Magic Link** en zet de tekst in het Nederlands. Voeg `{{ .Token }}` toe, dan staat er ook een code in de mail. Die code kun je op de site invullen, wat handig is als de link op een andere computer opengaat.

### 3. GitHub Pages
1. Maak een **openbare** repository `vergaderruimtes` aan en zet `index.html` erin.
2. Ga naar **Settings → Pages**, kies *Deploy from a branch*, dan `main` en `/ (root)`.
3. Na ongeveer een minuut staat de site op `https://<jouw-github-naam>.github.io/vergaderruimtes/`.

> In `index.html` staat alleen de *publishable key*. Die mag openbaar zijn: de database laat alleen ingelogde, uitgenodigde deelnemers iets zien. Dat is getest.

### 4. Gmail-script (Apps Script)
1. Log in met het ruimte-Gmailaccount op <https://script.google.com> en maak een **nieuw project**: *Vergaderruimtes*.
2. Plak de inhoud van `Code.gs`. Gebruik de versie **met sleutel** die je apart hebt gekregen. Zet die versie niet op GitHub.
3. Zet bij *Projectinstellingen* het vinkje aan bij *"appsscript.json weergeven in editor"*. Plak dan de inhoud van `appsscript.json` in dat bestand.
4. Kies bovenaan de functie `testVerbinding` en klik op **Uitvoeren**. Geef toestemming. Bij "Google heeft deze app niet geverifieerd" klik je op Geavanceerd → Ga naar Vergaderruimtes. In het logboek moet `{"status":"unknown_room"}` verschijnen.
5. Kies daarna de functie `installeer` en klik op **Uitvoeren**. Vanaf dat moment wordt de mailbox elke minuut gecontroleerd.

### 5. Deelnemers toevoegen
Log in op de site en ga naar *Beheer → Projectdeelnemers*. Voeg de e-mailadressen toe en stuur de mensen de link naar de site.

## Hoe het uitnodigen via Outlook werkt

| Actie in Outlook | Resultaat |
|---|---|
| Ruimte als genodigde toevoegen | Is de ruimte vrij, dan volgt een acceptatie en een boeking. Is ze bezet, dan volgt een weigering met de reden en de botsende tijden. |
| Vergadering verplaatsen | De boeking wordt aangepast. Als het nieuwe tijdstip bezet is, volgt een weigering en blijft de oude boeking staan. |
| Vergadering annuleren of ruimte verwijderen | De boeking vervalt. |
| Terugkerende vergadering | Dagelijks, wekelijks en maandelijks worden ondersteund, tot maximaal 104 keer of 1 jaar vooruit. |
| Organisator niet op de deelnemerslijst | Weigering. |

Ook één los exemplaar van een reeks verplaatsen of annuleren in Outlook wordt goed verwerkt. De rest van de reeks blijft dan staan.

## Gratis limieten
- Supabase Free: ruim voldoende. Een project dat 7 dagen niet wordt gebruikt, wordt gepauzeerd. Het script stuurt daarom elke dag een ping om dat te voorkomen.
- Gmail SMTP: circa 500 mails per dag.
- Apps Script: een run elke minuut blijft ruim binnen de gratis quota.
