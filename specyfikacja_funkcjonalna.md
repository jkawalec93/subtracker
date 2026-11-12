# Specyfikacja Funkcjonalna Projektu: SubTrack

## 1. Cel Projektu i Założenia Ogólne
Projekt **SubTrack** ma na celu stworzenie niezależnego, prywatnego systemu do zarządzania, monitorowania oraz optymalizacji stałych kosztów cyklicznych (subskrypcje) oraz usług realizowanych na żądanie (on-demand), w których osadzone są metody płatności.

Głównym zadaniem systemu jest eliminacja zjawiska tzw. *subscription fatigue* (niekontrolowanego odpływu kapitału przez zapomniane subskrypcje i okresy próbne) oraz zapobieganie sytuacjom blokady usług z powodu wygaśnięcia kart płatniczych.

### Etap 1: walidacja na sobie
Pierwsza wersja służy sprawdzeniu, czy aplikacja jest przydatna w codziennym użyciu. Z tego wynikają założenia:
*   **Jeden użytkownik** (właściciel). Współużytkownicy planów rodzinnych są lokalnymi profilami, a nie kontami.
*   **Web-first:** aplikacja webowa, responsywna, używana z przeglądarki na PC oraz na iPhonie (Safari, „Dodaj do ekranu głównego” jako PWA).
*   **Dane lokalnie:** mały serwer + plik SQLite, uruchamiany na prywatnym sprzęcie. Bez chmury i bez kont.
*   Aplikacja mobilna (iOS/Android) i hosting w chmurze powstają dopiero, jeśli etap 1 się sprawdzi (patrz sekcja 7).

### Założenia stałe
*   **Autonomia:** w czasie działania aplikacja nie korzysta z żadnych zewnętrznych usług sieciowych (API, CDN, kursy walut, AI). Wyjątki mogą dotyczyć tylko integracji, które użytkownik świadomie włączy i skonfiguruje (np. powiadomienia push w wersji 1.1).
*   **Bezpieczeństwo danych:** aplikacja kategorycznie **nie gromadzi** wrażliwych danych finansowych (pełne numery kart, kody CVV/CVC, hasła bankowe). Przechowywane są wyłącznie nazwy własne i terminy ważności instrumentów płatniczych podane manualnie przez użytkownika.
*   **Gotowość na wzrost:** model danych i podział kodu mają pozwolić na późniejsze przejście do chmury i dodanie klienta mobilnego bez przepisywania logiki (patrz sekcja 2.3).

---

## 2. Architektura i Stack Technologiczny

### 2.1 Stack
| Warstwa | Technologia |
|---|---|
| Język | TypeScript (cały projekt) |
| Frontend | React + Vite, PWA (manifest, ikona, instalacja na iPhonie) |
| API | Hono na Node.js, REST/JSON |
| Baza danych | SQLite (better-sqlite3) + Drizzle ORM z migracjami |
| Daty | date-fns (operacje wyłącznie na datach bez godzin) |
| Testy | Vitest |
| Uruchomienie | jeden proces Node serwuje API i zbudowany frontend; opcjonalnie obraz Docker |

### 2.2 Struktura kodu
```
src/
  domain/   # czysta logika bez I/O: daty i cykle, podział kosztów, generator należności, alerty, migracja karty
  db/       # schemat Drizzle, migracje, repozytoria
  server/   # Hono: endpointy REST, scheduler, backup, konfiguracja
  web/      # React: widoki i komponenty, klient API
tests/      # testy (przede wszystkim domain/)
```
*   `domain/` nie importuje niczego z `db/`, `server/` ani `web/`. To warunek późniejszego współdzielenia logiki z aplikacją mobilną i backendem w chmurze.
*   `web/` komunikuje się z danymi wyłącznie przez REST API. Nie ma bezpośredniego dostępu do bazy.
*   `server/` korzysta z bazy wyłącznie przez repozytoria z `db/`.

### 2.3 Zasady przygotowujące pod chmurę i mobile
*   Klucze główne to **UUID (v7)**, nie autoinkrement.
*   Każda tabela ma kolumny `created_at`, `updated_at`, `deleted_at`.
*   **Soft-delete:** rekordy oznacza się w `deleted_at` zamiast je usuwać. Rekordów finansowych (zdarzenia płatności, należności) nie usuwa się nigdy.
*   **Kwoty** to liczby całkowite w jednostkach podstawowych waluty (grosze, centy) + kod waluty ISO 4217. Bez typów zmiennoprzecinkowych.
*   **Migracje schematu** od pierwszego dnia. Baza zawsze powstaje wyłącznie z migracji.
*   REST API projektowane tak, by mógł z niego korzystać także przyszły klient mobilny.

### 2.4 Dostęp i backup
*   Domyślnie serwer nasłuchuje tylko na `127.0.0.1`. Nasłuch w sieci lokalnej (dostęp z iPhone'a) wymaga ustawienia hasła w zmiennej środowiskowej `APP_PASSWORD`. Bez hasła serwer odmawia startu w tym trybie.
*   **Backup automatyczny:** raz dziennie `VACUUM INTO` do katalogu `backups/`, z retencją ostatnich 14 kopii.
*   **Eksport/import JSON** całej bazy z poziomu UI, jako przenośna kopia i przyszła ścieżka migracji do chmury.

---

## 3. Zakres Funkcjonalny Wersji Bazowej (MVP)

### 3.1 Moduł portfela i metod płatności
*   **Rejestr metod płatności** z typami:
    *   `card`: karta fizyczna (nazwa własna, marka: Visa/Mastercard/Amex/inna, data ważności MM/RR),
    *   `wallet`: portfel lub pośrednik (PayPal, Apple Pay, Google Pay, Revolut…),
    *   `store_account`: konto sklepu z aplikacjami (Apple ID, Google Play), przez które idzie wiele subskrypcji,
    *   `bank_account`: rachunek (polecenie zapłaty, przelew cykliczny),
    *   `carrier_billing`: doliczanie do rachunku operatora,
    *   `other`.
*   **Zależności wielopoziomowe:** każda metoda inna niż karta może wskazywać metodę, która ją finansuje (np. Apple ID → karta, PayPal → karta). W MVP jedna metoda finansująca na pośrednika. Łańcuch nie może zawierać cykli, a jego maksymalna głębokość to 5.
*   **Wymiana karty:** przy wpisaniu nowej karty można wskazać, którą kartę zastępuje (`replaces`). To uruchamia migrację (3.1, ostatni punkt).
*   **Alerty ważności:** karta jest ważna do ostatniego dnia miesiąca z daty MM/RR. Alert pojawia się po przekroczeniu progów (domyślnie 60, 30 i 7 dni przed wygaśnięciem; progi konfigurowalne w ustawieniach).
*   **Migracja karty (checklista):** dla wygasającej lub zastępowanej karty system generuje listę miejsc do aktualizacji:
    *   usługi opłacane **bezpośrednio** tą kartą (pozycja per usługa),
    *   **pośrednicy** finansowani tą kartą (jedna pozycja per pośrednik, bo jego aktualizacja naprawia wszystkie usługi za nim). Usługi za pośrednikiem są wyświetlane informacyjnie pod pozycją pośrednika.

    Każdą pozycję można odhaczyć jako „zaktualizowano”. Odhaczenie przepina powiązanie na nową kartę (jeśli wskazano), a postęp migracji jest zapamiętywany.

### 3.2 Moduł usług i subskrypcji
*   **Subskrypcje:** nazwa, kategoria, kwota, waluta, cykl rozliczeniowy (co N tygodni, miesięcy lub lat), data kolejnej płatności, metoda płatności, płatnik (domyślnie właściciel), notatka.
*   **Statusy subskrypcji:**
    *   `trial`: okres próbny z datą końca. Pierwsza płatność następuje w dniu końca trialu. Alert pojawia się 3 dni przed końcem (konfigurowalne).
    *   `active`.
    *   `paused`: nie generuje płatności. Wznowienie wymaga podania nowej daty kolejnej płatności.
    *   `cancelled`: z datą „opłacone do”. Po tej dacie nie generuje płatności.
*   **Historia cen:** zmiana kwoty zapisuje nową cenę z datą obowiązywania. Płatności sprzed tej daty zachowują starą kwotę.
*   **Usługi On-Demand:** rejestracja aplikacji bez abonamentu (Bolt, Uber, Glovo…) z przypisaną metodą płatności, w celu monitorowania jej integralności (te usługi też trafiają do migracji karty).
*   **Kategorie:** prosta lista definiowana przez użytkownika (rozrywka, transport, chmura…).

### 3.3 Rejestr transakcyjny i rozliczenia współdzielone
*   **Profile współużytkowników:** lokalne profile osób (np. Kamil, Ania). Właściciel ma własny profil z flagą `is_me`.
*   **Uczestnicy subskrypcji:** przy subskrypcji rodzinnej użytkownik wskazuje osoby partycypujące w kosztach (właściciel jest uczestnikiem domyślnie), z datą dołączenia i opcjonalną datą odejścia.
*   **Tryby podziału:**
    *   `equal` (domyślny): po równo między uczestników,
    *   `percent`: udział procentowy per osoba,
    *   `fixed`: stała kwota per osoba, resztę pokrywa płatnik.
*   **Księgowość transakcyjna (rekord po rekordzie):** w każdym cyklu płatności system rejestruje **zdarzenie płatności** (usługa, data, kwota). Dla każdego uczestnika innego niż płatnik powstaje osobna **należność**: `Osoba - Usługa - Data naliczenia - Kwota - Status (rozliczono: TAK/NIE)`.
*   **Kierunek „ja jestem winny”:** jeśli płatnikiem subskrypcji jest inna osoba (np. Ania płaci za YouTube Premium), należności powstają po stronie właściciela. Bilans pokazuje obie strony bez potrzeby parowania kont.
*   **Panel księgowy:** filtrowanie należności po osobie, usłudze, statusie i okresie. Można rozliczać pojedyncze należności lub ich grupy (np. zamknięcie długu za Spotify bez ruszania długu za Netflix) oraz cofnąć rozliczenie. Panel pokazuje saldo per osoba i per waluta.

### 3.4 Pulpit „Wymaga uwagi”
Ekran startowy agregujący:
*   karty przekraczające progi ważności oraz otwarte migracje kart,
*   usługi, których metoda płatności (bezpośrednio lub w łańcuchu) jest wygasła lub zarchiwizowana,
*   triale kończące się w najbliższym czasie,
*   płatności w ciągu najbliższych 7 dni,
*   suma kosztów miesięcznych i rocznych (osobno per waluta, łącznie i „mój udział”).

W MVP alerty są widoczne w aplikacji. Powiadomienia push i e-mail są w wersji 1.1.

---

## 4. Model Danych
Wszystkie tabele mają dodatkowo: `id` (UUID v7, PK), `created_at`, `updated_at`, `deleted_at`. Daty bez godzin zapisywane są jako tekst `YYYY-MM-DD`. Klucze obce są wymuszane (`PRAGMA foreign_keys = ON`).

| Tabela | Kolumny | Uwagi |
|---|---|---|
| `persons` | `name`, `is_me`, `linked_account_id` (null) | dokładnie jedna osoba z `is_me = 1`; `linked_account_id` zarezerwowane na parowanie w v2 |
| `payment_methods` | `name`, `kind`, `card_brand` (null), `expiry_month` (null), `expiry_year` (null), `funded_by_id` (FK → `payment_methods`, null), `replaces_id` (FK → `payment_methods`, null), `archived_at` (null) | pola karty tylko dla `kind = card`; `funded_by_id` tylko dla typów innych niż karta |
| `categories` | `name` | |
| `services` | `name`, `kind` (`subscription` / `on_demand`), `category_id` (null), `payment_method_id` (null), `payer_person_id`, `status`, `interval_unit` (`week` / `month` / `year`), `interval_count`, `billing_anchor_date`, `trial_ends_at` (null), `paid_until` (null), `split_mode`, `notes` | pola cyklu tylko dla subskrypcji; `payment_method_id` może być pusta, gdy płaci inna osoba |
| `service_prices` | `service_id`, `amount_minor`, `currency`, `valid_from` | cena obowiązująca w dniu X to rekord z największym `valid_from ≤ X` |
| `service_participants` | `service_id`, `person_id`, `share_value` (null), `joined_at`, `left_at` (null) | `share_value`: punkty bazowe (`percent`, suma 10000) lub kwota w groszach (`fixed`) |
| `billing_events` | `service_id`, `period_start`, `amount_minor`, `currency` | UNIQUE(`service_id`, `period_start`); historia faktycznych płatności |
| `charges` | `billing_event_id`, `person_id`, `amount_minor`, `currency`, `settled_at` (null) | UNIQUE(`billing_event_id`, `person_id`); należność wobec płatnika |
| `card_migrations` | `old_method_id`, `new_method_id` (null), `completed_at` (null) | |
| `card_migration_items` | `migration_id`, `service_id` (null), `payment_method_id` (null), `done_at` (null) | pozycja dotyczy usługi bezpośredniej albo pośrednika |
| `settings` | `key`, `value` | progi alertów, strefa czasowa, retencja backupu |

---

## 5. Reguły Biznesowe
*   **Strefa czasowa:** wszystkie obliczenia dat w strefie `Europe/Warsaw` (konfigurowalnej). „Dziś” to data lokalna.
*   **Koniec miesiąca:** kolejne daty płatności liczy się zawsze od `billing_anchor_date`, a nie od poprzedniej płatności. Jeśli dany miesiąc nie ma dnia z daty bazowej, płatność przypada na jego ostatni dzień (31.01 → 28.02 → 31.03).
*   **Ważność karty:** karta MM/RR jest ważna do ostatniego dnia miesiąca MM włącznie.
*   **Zaokrąglenia:** udziały liczone w groszach, zaokrąglane w dół. Reszta (różnica do kwoty całkowitej) przypada płatnikowi. Przykład: 49,99 zł / 3 = 16,66 + 16,66 + 16,67 (płatnik).
*   **Uczestnictwo w okresie:** osoba uczestniczy w zdarzeniu płatności, jeśli `joined_at ≤ period_start` i (`left_at` puste lub `period_start < left_at`). Zmiany uczestników nie modyfikują istniejących należności.
*   **Scheduler (generator płatności):** uruchamiany przy starcie serwera i codziennie o 06:00. Dla każdej subskrypcji generuje wszystkie brakujące zdarzenia płatności z `period_start ≤ dziś`, wraz z należnościami. Działa **nadrabiająco** (serwer mógł być wyłączony) i **idempotentnie**: ponowne uruchomienie nie tworzy duplikatów, co gwarantują ograniczenia UNIQUE.
*   **Statusy a generowanie:** `trial` generuje dopiero od `trial_ends_at`; `paused` nie generuje; `cancelled` generuje tylko do `paid_until` włącznie.
*   **Waluty:** brak przeliczeń kursowych w MVP. Sumy i salda pokazywane osobno dla każdej waluty.
*   **Archiwizacja metody płatności:** nie usuwa powiązań. Usługi korzystające z niej (bezpośrednio lub przez łańcuch) trafiają na pulpit „Wymaga uwagi” z komunikatem o braku aktywnej metody płatności.
*   **Usuwanie:** usunięcie usługi lub osoby to soft-delete. Zdarzenia płatności i należności pozostają w historii (z nazwą usługi lub osoby oznaczoną jako usunięta).

---

## 6. Definicja Ukończenia Zadania (Definition of Done - DoD)
Moduły implementowane (również przez agenta AI) uznaje się za ukończone wyłącznie przy spełnieniu poniższych kryteriów:

1.  **Build i jakość:** `npm run build`, `npm run typecheck` i `npm run lint` kończą się bez błędów i bez ostrzeżeń.
2.  **Testy logiki:** testy Vitest dla `domain/` przechodzą i obejmują co najmniej:
    *   daty płatności dla dnia 29–31, lat przestępnych, cykli tygodniowych, miesięcznych, rocznych i co N,
    *   podział kosztów we wszystkich trybach wraz z regułą zaokrągleń,
    *   idempotencję i nadrabianie schedulera (wielokrotne uruchomienie, przerwa kilku cykli),
    *   statusy `trial`, `paused`, `cancelled` oraz zmianę ceny w trakcie,
    *   ważność kart i progi alertów,
    *   budowę checklisty migracji karty z pośrednikami (w tym łańcuchy i blokadę cykli).
3.  **Spójność danych:** baza powstaje z migracji na pustym pliku; klucze obce są wymuszane; rekordy finansowe nie są usuwane; archiwizacja metody płatności poprawnie oznacza zależne usługi.
4.  **UI/UX:** interfejs jest responsywny od 360 px szerokości do desktopu, sprawdzony w Chrome (desktop) i Safari (iPhone). Dark Mode jest motywem domyślnym, a aplikację da się zainstalować na ekranie głównym iPhone'a.
5.  **Autonomia:** aplikacja w czasie działania nie wykonuje żadnych żądań do zewnętrznych serwerów. Czcionki, ikony i biblioteki są dołączone do builda.
6.  **Architektura:** zachowany podział warstw z sekcji 2.2 (`domain/` bez zależności od pozostałych warstw), a kod ma komentarze strukturalne ułatwiające samodzielną modyfikację.
7.  **Dokumentacja:** README opisuje uruchomienie, konfigurację (`APP_PASSWORD`, port, ścieżka bazy), backup i odtworzenie z kopii.

---

## 7. Krokowa Mapa Drogowa Przyszłego Rozwoju (Roadmap)

### Wersja 1.1 – Powiadomienia i wygoda
*   Powiadomienia push na iPhone'a przez [ntfy](https://ntfy.sh) (własny serwer lub publiczny) i/lub e-mail. Funkcja opcjonalna, włączana przez użytkownika.
*   Jasny motyw do wyboru.
*   Proste statystyki: koszt per kategoria, prognoza roczna.

### Wersja 2.0 – Upublicznienie i aplikacja mobilna
Realizowana tylko, jeśli etap 1 się sprawdzi.
*   **Hosting w chmurze:** ten sam serwer wdrożony w chmurze, z kontami użytkowników i uwierzytelnianiem. Do tabel dochodzi właściciel danych (`owner_id`); rozważenie przejścia z SQLite na PostgreSQL (Drizzle obsługuje oba).
*   **Aplikacja mobilna:** Expo (React Native) korzystająca z tego samego REST API i współdzielonego modułu `domain/`. Do dystrybucji na iOS potrzebne są Apple Developer Program i EAS Build.
*   **Sieć zaufana (P2P):** parowanie niezależnie zarejestrowanych użytkowników za obopólną, jawną zgodą (zaproszenia, kody QR); lokalny profil osoby łączony z kontem przez `linked_account_id`.
*   **Dwukierunkowy bilans płatniczy:** automatyczne „ile ja jestem winny komu i za co” na podstawie subskrypcji współdzielonych przez innych użytkowników.
*   **Powiadomienia i udostępnianie w aplikacji:** wysłanie sparowanemu użytkownikowi podsumowania z prośbą o przelew (wraz z danymi do płatności/BLIK).

### Wersja 3.0 – Agregacja gospodarstwa domowego
*   **Widok „Rodziny” (Family Hub):** zagregowany podgląd wydatków na subskrypcje dla par i rodzin (wspólne zestawienie, podział na kategorie, estymacje roczne dla całego domu).

### Furtka architektoniczna na przyszłe rozszerzenia
Model danych i API pozostawiają przestrzeń na:
*   **Open Banking / PSD2:** automatyczny odczyt historii transakcji w celu weryfikacji płatności zamiast ręcznego potwierdzania. Wymaga licencjonowanego agregatora (AISP), więc jest świadomym wyjątkiem od zasady autonomii.
*   **Analitykę predyktywną:** wykresy trendów, sugestie rezygnacji z rzadko używanych usług.
*   **Automatyzację powiadomień:** webhooki do komunikatorów zewnętrznych.

---

## 8. Decyzje Otwarte
*   Czy zapisywać ostatnie 4 cyfry karty? Pomagają odróżnić karty o podobnych nazwach i według standardu PCI DSS nie są daną wrażliwą, ale wykraczają poza obecną zasadę „tylko nazwa i data ważności”.
*   Czy pośrednik może mieć kilka metod finansujących (np. PayPal z kartą główną i zapasową)? W MVP przyjęto jedną.
