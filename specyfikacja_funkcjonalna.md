# Specyfikacja Funkcjonalna Projektu: SubTrack

## 1. Cel Projektu i Założenia Ogólne
Projekt **SubTrack** ma na celu stworzenie niezależnego, prywatnego systemu do zarządzania, monitorowania oraz optymalizacji stałych kosztów cyklicznych (subskrypcje) oraz usług realizowanych na żądanie (on-demand), w których osadzone są metody płatności.

Głównym zadaniem systemu jest eliminacja zjawiska tzw. *subscription fatigue* (niekontrolowanego odpływu kapitału przez zapomniane subskrypcje i okresy próbne) oraz zapobieganie sytuacjom blokady usług z powodu wygaśnięcia kart płatniczych.

### Etap 1 (MVP): walidacja na sobie — aplikacja osobista na desktop
Pierwsza wersja służy sprawdzeniu, czy aplikacja jest przydatna w codziennym użyciu. Z tego wynikają założenia:
*   **Jeden użytkownik (użytek osobisty):** MVP skupia się na własnych subskrypcjach, usługach on-demand i metodach płatności. Moduł współdzielenia kosztów i rozliczeń między osobami został świadomie odroczony do osobnej iteracji (sekcja 7).
*   **Web-first (desktop):** aplikacja webowa zoptymalizowana w pierwszej kolejności pod przeglądarki desktopowe na Windowsie (np. Brave), z zachowaniem responsywności i czystego REST API pod przyszłą aplikację mobilną.
*   **Dane lokalnie:** mały serwer + plik SQLite, uruchamiany na prywatnym sprzęcie. Bez chmury i bez kont.
*   Aplikacja mobilna (iOS/Android), współdzielenie kosztów i hosting w chmurze powstają w kolejnych etapach (patrz sekcja 7).

### Założenia stałe
*   **Autonomia:** w czasie działania aplikacja nie korzysta z żadnych zewnętrznych usług sieciowych (API, CDN, kursy walut, AI). Wyjątki mogą dotyczyć tylko integracji, które użytkownik świadomie włączy i skonfiguruje (np. powiadomienia push w wersji 1.1).
*   **Bezpieczeństwo danych:** aplikacja kategorycznie **nie gromadzi** wrażliwych danych finansowych (pełne numery kart, kody CVV/CVC, hasła bankowe). Przechowywane są wyłącznie nazwy własne, opcjonalnie ostatnie 4 cyfry karty (`last4`) oraz terminy ważności instrumentów płatniczych podane manualnie przez użytkownika.
*   **Gotowość na wzrost:** model danych i podział kodu mają pozwolić na późniejsze dodanie współdzielenia kosztów, klienta mobilnego oraz przejście do chmury bez przepisywania logiki (patrz sekcja 2.3).

---

## 2. Architektura i Stack Technologiczny

### 2.1 Stack
| Warstwa | Technologia |
|---|---|
| Język | TypeScript (cały projekt) |
| Frontend | React + Vite + Tailwind CSS |
| API | Hono na Node.js, REST/JSON |
| Baza danych | SQLite (`better-sqlite3`) + Drizzle ORM z migracjami |
| Daty | `date-fns` (operacje wyłącznie na datach bez godzin) |
| Jakość | ESLint (`npm run lint`) + `tsc --noEmit` (`npm run typecheck`) |
| Testy | Vitest |
| Uruchomienie | jeden proces Node serwuje API i zbudowany frontend; opcjonalnie obraz Docker |

### 2.2 Struktura kodu
```
src/
  domain/   # czysta logika bez I/O: daty i cykle, generator zdarzeń płatności, alerty, migracja karty, wyliczenia kosztów
  db/       # schemat Drizzle, migracje SQL, repozytoria
  server/   # Hono: endpointy REST, uwierzytelnianie, scheduler, backup, konfiguracja
  web/      # React: widoki i komponenty, klient API
tests/      # testy (przede wszystkim domain/)
```
*   `domain/` nie importuje niczego z `db/`, `server/` ani `web/` (wymuszane automatycznie przez regułę ESLint). To warunek późniejszego współdzielenia logiki z aplikacją mobilną i backendem w chmurze.
*   `web/` komunikuje się z danymi wyłącznie przez REST API. Nie ma bezpośredniego dostępu do bazy.
*   `server/` korzysta z bazy wyłącznie przez repozytoria z `db/`.

### 2.3 Zasady przygotowujące pod chmurę i mobile
*   Klucze główne to **UUID (v7)**, nie autoinkrement.
*   Każda tabela ma kolumny `created_at`, `updated_at`, `deleted_at`.
*   **Soft-delete:** rekordy oznacza się w `deleted_at` zamiast je usuwać. Rekordów finansowych (`billing_events`) nie usuwa się nigdy.
*   **Kwoty** to liczby całkowite w jednostkach podstawowych waluty (grosze, centy) + kod waluty ISO 4217. Bez typów zmiennoprzecinkowych.
*   **Migracje schematu** od pierwszego dnia. Baza zawsze powstaje wyłącznie z migracji Drizzle.
*   REST API projektowane tak, by mógł z niego korzystać także przyszły klient mobilny.

### 2.4 Dostęp, uwierzytelnianie i backup
*   **Tryb lokalny (domyślny):** serwer nasłuchuje wyłącznie na `127.0.0.1` bez wymogu logowania.
*   **Tryb sieciowy:** nasłuch w sieci lokalnej wymaga ustawienia hasła w zmiennej środowiskowej `APP_PASSWORD`. Bez hasła serwer odmawia startu w tym trybie.
    *   Gdy `APP_PASSWORD` jest ustawione, UI pokazuje ekran logowania; serwer wystawia sesję w cookie `HttpOnly` oraz akceptuje nagłówek `Authorization: Bearer` (pod przyszłego klienta mobilnego).
*   **Backup automatyczny:** raz dziennie `VACUUM INTO` do katalogu `backups/`, z retencją ostatnich 14 kopii.
*   **Eksport/import JSON** całej bazy z poziomu UI (zawiera wersję schematu oraz wszystkie tabele wraz z rekordami `deleted_at` i historią płatności):
    *   Import działa jako **pełne odtworzenie stanu w jednej transakcji** po uprzedniej walidacji struktury i spójności danych.
    *   Przed nadpisaniem danych import automatycznie zapisuje kopię zapasową aktualnej bazy w `backups/`. W razie błędu transakcja jest wycofywana.

---

## 3. Zakres Funkcjonalny Wersji Bazowej (MVP)

### 3.1 Moduł portfela i metod płatności
*   **Rejestr metod płatności** z typami:
    *   `card`: karta fizyczna lub wirtualna (nazwa własna, marka: Visa/Mastercard/Amex/inna, opcjonalnie ostatnie 4 cyfry `last4`, data ważności `MM/RR`),
    *   `wallet`: portfel lub pośrednik (PayPal, Apple Pay, Google Pay, Revolut…),
    *   `store_account`: konto sklepu z aplikacjami (Apple ID, Google Play), przez które idzie wiele subskrypcji,
    *   `bank_account`: rachunek (polecenie zapłaty, przelew cykliczny),
    *   `carrier_billing`: doliczanie do rachunku operatora,
    *   `other`.
*   **Zależności wielopoziomowe:** każda metoda inna niż karta może wskazywać jedną metodę, która ją finansuje (np. Apple ID → karta, PayPal → karta). Łańcuch nie może zawierać cykli, a jego maksymalna głębokość to 5.
*   **Wymiana karty:** przy wpisaniu nowej karty można wskazać, którą kartę zastępuje (`replaces_id`). Uruchamia to migrację karty (albo dopina nową kartę do istniejącej otwartej migracji bez wskazanej nowej karty).
*   **Alerty ważności:** karta jest ważna do ostatniego dnia miesiąca z daty `MM/RR`. Alert pojawia się po przekroczeniu progów (domyślnie 60, 30 i 7 dni przed wygaśnięciem; progi konfigurowalne w ustawieniach).
*   **Migracja karty (checklista):** dla wygasającej lub zastępowanej karty system generuje listę miejsc do aktualizacji:
    *   usługi (`subscription` oraz `on_demand` o statusie `active`, `trial` lub `paused` — z pominięciem `cancelled` i usuniętych) opłacane **bezpośrednio** tą kartą (pozycja per usługa),
    *   niezarchiwizowani **pośrednicy** finansowani tą kartą (jedna pozycja per pośrednik, bo jego aktualizacja naprawia wszystkie usługi za nim). Usługi za pośrednikiem są wyświetlane informacyjnie pod pozycją pośrednika.
    *   Migrację można utworzyć również **zanim** użytkownik otrzyma nową kartę (`new_method_id = null`). Jeśli później zostanie dodana karta z `replaces_id` na tę samą starą kartę, dopina się ona do otwartej migracji.
    *   Każdą pozycję można odhaczyć jako „zaktualizowano” (`done_at`). Jeśli wskazano `new_method_id`, odhaczenie automatycznie przepina powiązanie usługi lub pośrednika na nową kartę.
    *   Po odhaczeniu ostatniej pozycji migracja oznacza się jako zakończona (`completed_at`), a jeśli wskazano `new_method_id`, stara karta jest automatycznie archiwizowana (`archived_at`).

### 3.2 Moduł usług i subskrypcji
*   **Subskrypcje:** nazwa, kategoria, kwota, waluta, cykl rozliczeniowy (co `N` tygodni, miesięcy lub lat), data kolejnej płatności (`billing_anchor_date`), metoda płatności, notatka.
*   **Statusy subskrypcji:**
    *   `trial`: okres próbny z datą końca (`trial_ends_at`). `billing_anchor_date` ustawia się automatycznie na `trial_ends_at`. Pierwsza płatność następuje w dniu końca trialu, a scheduler automatycznie przełącza wtedy status na `active`. Alert pojawia się 3 dni przed końcem (konfigurowalne).
    *   `active`: generuje płatności zgodnie z cyklem.
    *   `paused`: nie generuje płatności. Wznowienie (`paused` → `active`) wymaga podania nowej daty kolejnej płatności, która nadpisuje `billing_anchor_date` (okres przerwy nie jest nadrabiany).
    *   `cancelled`: z datą „opłacone do” (`paid_until`). Generuje ewentualne płatności tylko do `paid_until` włącznie; po tej dacie wygasa.
*   **Historia cen:** zmiana kwoty zapisuje nową cenę z datą obowiązywania (`valid_from`). Płatności sprzed tej daty zachowują starą kwotę. Maksymalnie jedna cena na ten sam dzień `valid_from` dla jednej usługi (korekta w tym samym dniu nadpisuje wpis).
*   **Usługi On-Demand:** rejestracja aplikacji bez abonamentu (Bolt, Uber, Glovo…) z przypisaną metodą płatności (pola cyklu oraz cena pozostają puste/`null`), w celu monitorowania integralności metody płatności i uwzględniania w migracji karty. Domyślny status to `active` (może zostać `cancelled` lub soft-deleted).
*   **Kategorie:** prosta lista definiowana przez użytkownika (rozrywka, transport, chmura…).

### 3.3 Pulpit „Wymaga uwagi” i podsumowanie kosztów
Ekran startowy agregujący:
*   karty przekraczające progi ważności oraz otwarte migracje kart,
*   usługi, których metoda płatności (bezpośrednio lub w łańcuchu) jest wygasła lub zarchiwizowana,
*   triale kończące się w najbliższym czasie,
*   płatności w ciągu najbliższych 7 dni,
*   **suma kosztów miesięcznych i rocznych** (osobno per waluta):
    *   wliczane są subskrypcje o statusie `active` (wg ceny obowiązującej „dziś”); `paused` i `cancelled` są pomijane, a koszt subskrypcji w `trial` może być pokazany osobno jako informacja o nadchodzących kosztach po zakończeniu okresu próbnego.

---

## 4. Model Danych
Wszystkie tabele mają dodatkowo: `id` (UUID v7, PK), `created_at`, `updated_at`, `deleted_at`. Daty bez godzin zapisywane są jako tekst `YYYY-MM-DD`. Klucze obce są wymuszane (`PRAGMA foreign_keys = ON`).

| Tabela | Kolumny | Uwagi |
|---|---|---|
| `payment_methods` | `name`, `kind`, `card_brand` (null), `last4` (null), `expiry_month` (null), `expiry_year` (null), `funded_by_id` (FK → `payment_methods`, null), `replaces_id` (FK → `payment_methods`, null), `archived_at` (null) | pola karty (`card_brand`, `last4`, `expiry_*`) tylko dla `kind = card`; `funded_by_id` tylko dla typów innych niż karta |
| `categories` | `name` | |
| `services` | `name`, `kind` (`subscription` / `on_demand`), `category_id` (null), `payment_method_id` (null), `status`, `interval_unit` (`week` / `month` / `year`, null), `interval_count` (null), `billing_anchor_date` (null), `trial_ends_at` (null), `paid_until` (null), `notes` (null) | pola cyklu (`interval_unit`, `interval_count`, `billing_anchor_date`) wyłącznie dla `kind = subscription`; puste dla `on_demand` |
| `service_prices` | `service_id`, `amount_minor`, `currency`, `valid_from` | `UNIQUE(service_id, valid_from)` (dla aktywnych wpisów); cena w dniu X to rekord z największym `valid_from ≤ X` |
| `billing_events` | `service_id`, `period_start`, `amount_minor`, `currency` | `UNIQUE(service_id, period_start)`; historia faktycznych płatności |
| `card_migrations` | `old_method_id`, `new_method_id` (null), `completed_at` (null) | |
| `card_migration_items` | `migration_id`, `service_id` (null), `payment_method_id` (null), `done_at` (null) | pozycja dotyczy usługi bezpośredniej albo pośrednika |
| `settings` | `key`, `value` | progi alertów, strefa czasowa, retencja backupu |

---

## 5. Reguły Biznesowe
*   **Strefa czasowa:** wszystkie obliczenia dat w strefie `Europe/Warsaw` (konfigurowalnej). „Dziś” to data lokalna.
*   **Koniec miesiąca:** kolejne daty płatności liczy się zawsze od `billing_anchor_date`, a nie od poprzedniej płatności. Jeśli dany miesiąc nie ma dnia z daty bazowej, płatność przypada na jego ostatni dzień (31.01 → 28.02 → 31.03).
*   **Normalizacja kosztów miesięcznych i rocznych (zaokrąglenie do najbliższego grosza/centa):**
    *   `month` (co `N`): miesięczny = `kwota / N`, roczny = `kwota * 12 / N`.
    *   `year` (co `N`): roczny = `kwota / N`, miesięczny = `kwota / (12 * N)`.
    *   `week` (co `N`): roczny = `kwota * 52 / N`, miesięczny = `roczny / 12`.
*   **Ważność karty:** karta `MM/RR` jest ważna do ostatniego dnia miesiąca `MM` włącznie.
*   **Scheduler (generator płatności):** uruchamiany przy starcie serwera i codziennie o 06:00. Dla każdej subskrypcji generuje wszystkie brakujące zdarzenia płatności (`billing_events`) z `period_start ≤ dziś`. Działa **nadrabiająco** (serwer mógł być wyłączony) i **idempotentnie**: ponowne uruchomienie nie tworzy duplikatów, co gwarantuje `UNIQUE(service_id, period_start)`.
*   **Statusy a generowanie:** `trial` generuje pierwszą płatność od `trial_ends_at` i automatycznie przechodzi na `active`; `paused` nie generuje; `cancelled` generuje tylko do `paid_until` włącznie.
*   **Waluty:** brak przeliczeń kursowych w MVP. Sumy pokazywane osobno dla każdej waluty.
*   **Archiwizacja metody płatności:** nie usuwa powiązań. Usługi korzystające z niej (bezpośrednio lub przez łańcuch) trafiają na pulpit „Wymaga uwagi” z komunikatem o braku aktywnej metody płatności.
*   **Usuwanie:** usunięcie usługi, kategorii lub metody płatności to soft-delete (`deleted_at`). Zdarzenia płatności (`billing_events`) pozostają w historii na zawsze (z nazwą usługi oznaczoną jako usunięta).

---

## 6. Definicja Ukończenia Zadania (Definition of Done - DoD)
Moduły implementowane (również przez agenta AI) uznaje się za ukończone wyłącznie przy spełnieniu poniższych kryteriów:

1.  **Build i jakość:** `npm run build`, `npm run typecheck` i `npm run lint` kończą się bez błędów i bez ostrzeżeń.
2.  **Testy logiki:** testy Vitest dla `domain/` przechodzą i obejmują co najmniej:
    *   daty płatności dla dnia 29–31, lat przestępnych, cykli tygodniowych, miesięcznych, rocznych i co `N`,
    *   normalizację kosztów miesięcznych i rocznych dla wszystkich cykli i statusów,
    *   idempotencję i nadrabianie schedulera (wielokrotne uruchomienie, przerwa kilku cykli),
    *   statusy `trial` (z przejściem na `active`), `paused` (ze wznowieniem), `cancelled` (`paid_until`) oraz zmianę ceny w trakcie,
    *   ważność kart i progi alertów,
    *   budowę i aktualizację checklisty migracji karty z pośrednikami (w tym łańcuchy do głębokości 5, blokadę cykli, migrację bez `new_method_id` oraz auto-archiwizację po ukończeniu).
3.  **Spójność danych:** baza powstaje z migracji na pustym pliku; klucze obce są wymuszane; rekordy finansowe nie są usuwane; archiwizacja metody płatności poprawnie oznacza zależne usługi; eksport/import JSON działa transakcyjnie z kopią bezpieczeństwa.
4.  **UI/UX:** interfejs działa płynnie i przejrzyście w przeglądarce desktopowej (Brave/Chrome na Windows), z zachowaniem responsywnego układu. Dark Mode jest motywem domyślnym.
5.  **Autonomia:** aplikacja w czasie działania nie wykonuje żadnych żądań do zewnętrznych serwerów. Czcionki, ikony i biblioteki są dołączone do builda.
6.  **Architektura:** zachowany podział warstw z sekcji 2.2 (`domain/` bez zależności od pozostałych warstw, egzekwowane przez ESLint), a kod ma komentarze strukturalne ułatwiające samodzielną modyfikację.
7.  **Dokumentacja:** `README.md` opisuje uruchomienie, konfigurację (`APP_PASSWORD`, port, ścieżka bazy), backup i odtworzenie z kopii.

---

## 7. Krokowa Mapa Drogowa Przyszłego Rozwoju (Roadmap)

### Wersja 1.1 – Powiadomienia, mobilność webowa i wygoda
*   Powiadomienia push przez [ntfy](https://ntfy.sh) (własny serwer lub publiczny) i/lub e-mail. Funkcja opcjonalna, włączana przez użytkownika.
*   Pełne dopracowanie pod mobile web / PWA (iPhone Safari „Dodaj do ekranu głównego”, manifest, ikony).
*   Jasny motyw do wyboru.
*   Proste statystyki: koszt per kategoria, prognoza roczna, historia wydatków z `billing_events`.

### Wersja 1.2 – Współdzielenie kosztów i rozliczenia rodzinne (osobny feature)
*   Lokalne profile osób (`persons`, w tym `is_me`), uczestnicy subskrypcji (`service_participants` z `joined_at`/`left_at`).
*   Tryby podziału (`equal`, `percent`, `fixed`) wraz ze szczegółową analizą przypadków brzegowych (zmiana ceny, odejście uczestnika, rola płatnika).
*   Należności per zdarzenie płatności (`charges`) oraz panel księgowy rozliczeń (kto komu ile jest winien i za co).

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

## 8. Decyzje Rozstrzygnięte dla MVP
*   **Ostatnie 4 cyfry karty (`last4`):** dodajemy jako opcjonalne pole dla kart (`kind = 'card'`), aby ułatwić rozróżnianie kart o podobnych nazwach (nie jest daną wrażliwą wg PCI DSS).
*   **Metody finansujące pośrednika:** w MVP zostaje jedna metoda finansująca (`funded_by_id`) na pośrednika.
*   **Współdzielenie kosztów i rozliczenia:** odroczone z MVP do wersji 1.2 jako osobny feature z dedykowanym projektem przypadków użycia.
