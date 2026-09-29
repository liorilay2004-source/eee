# אפיון העלאה ל-Cloudflare — מבוצע על ידי הבעלים

> גרסה 1.1 · 2026-09-29 · היקף: ה-API של שלב 1 (Worker + מסד D1). הממשק (Pages) יגיע בשלב 2.
> **את Cloudflare מבצע הבעלים.** המסמך הזה נכתב כדי שתוכל לעשות הכול בעצמך, בסדר הנכון ובלי ניחושים. כל פלט שמצוין כאן נבדק מול ה-Worker שרץ מקומית על מסד D1 מקומי, מאותם קבצי מיגרציה. מסד ה-D1 כבר ממוגר ומאומת בחשבון שלך (סעיף 1); ה-Worker עצמו לא הועלה על ידי, ולכן פלטי סעיף 7 נבדקו רק מקומית.
> **סודות (טוקנים, מפתחות) לעולם לא בצ'אט, לא בקוד ולא ב-Issue.** מכניסים אותם רק בדשבורד של Cloudflare או ב-GitHub Secrets.

---

## 1. מה כבר נעשה ומה לא

| פריט | מצב |
|---|---|
| קוד ה-Worker (`worker/`) | כתוב ונבדק: `tsc` נקי, 807 בדיקות עוברות, 13 בדיקות פייתון עוברות. ממוזג ל-`main` (PR #2) |
| מסד D1 בשם `eee-db` | **נוצר בחשבון שלך** ב-2026-09-29 (מזהה `fe66df0f-f5ea-48af-8ccb-ea4e99c17145`, מיקום EEUR). **ממוגר ומאומת** (שורה הבאה) |
| Worker בשם `eee-api` | **לא הועלה על ידי** (וההעלאה שמורה לך). אם כבר חיברת Git בדשבורד או העלית בעצמך, דלג על סעיף 5 |
| מיגרציות | **הורצו ואומתו ב-2026-09-29:** 12 טבלאות (11 של המערכת + `d1_migrations`), 615 שדות תעופה ב-567 ערים, האינדקס `idx_prices_recent` והעמודה `search_cache.extra_json`. שלוש המיגרציות רשומות ב-`d1_migrations`, ולכן `wrangler d1 migrations apply` יענה "No migrations to apply". סכום ביקורת של תוכן `airports` במסד זהה לזה שמחושב מקובץ המקור (300083036) |
| סודות ומשתנים | **לא הוגדרו** |
| Workers ומסדים אחרים שלך | לא נגעתי בהם. נעשו רק קריאות רשימה ותיעוד |

## 2. רשימת המשאבים

| משאב | שם / ערך | הערה |
|---|---|---|
| Worker | `eee-api` | השם מוגדר ב-`worker/wrangler.toml`. **אם תחבר Git (סעיף 5, דרך א'), השם בדשבורד חייב להיות זהה בדיוק, אחרת הבנייה נכשלת** |
| מסד D1 | `eee-db` (binding בשם `DB`) | המזהה כבר כתוב ב-`wrangler.toml` |
| Cron | `17 3 * * *` (UTC) | ניקוי יומי: מחיר טיסות שעברו, יומן חיפושים ישן, מטמון ומונה קצב. בשעון ישראל בערך 05:17–06:17 |
| סוד `TRAVELPAYOUTS_TOKEN` | נדרש לחיפוש חי | בלעדיו `/api/search` מחזיר 503 (מוצג בסעיף 7) |
| סוד `TRAVELPAYOUTS_MARKER` | אופציונלי | מוסיף את קוד השותף שלך לקישורי ההזמנה |
| סוד `RATE_LIMIT_SALT` | **מומלץ בחוזקה** | מלח להצפנת כתובות לקוחות במונה הקצב. בלעדיו: אם יש `TRAVELPAYOUTS_TOKEN` המלח נגזר ממנו, **בלי שום התראה ביומן**; אם אין גם טוקן, המלח אקראי לכל מופע, נרשמת שגיאה ביומן, והמגבלה מפסיקה להיות משותפת בין מופעים. כלומר יומן נקי אינו מוכיח שהסוד מוגדר |
| משתנה `ALLOWED_ORIGIN` | **לא נדרש עכשיו** | כתובת הממשק המדויקת (ללא `*`). רלוונטי רק בשלב 2 |
| כתובת ציבורית | `https://eee-api.<תת-דומיין-שלך>.workers.dev` | תוצג לך אחרי ההעלאה |

## 3. תנאי קדם

- גישה לחשבון Cloudflare ול-GitHub (יש לך).
- קוד שלב 1 נמצא ב-`main` (PR #2 מוזג), ולכן `git clone` רגיל מספיק לכל הדרכים.
- לדרך ב': Node.js 22 ומסוף. אין מחשב זמין? אפשר לעבוד מ-GitHub Codespaces דרך הדפדפן.
- טוקן ו-Marker של Travelpayouts (לחיפוש חי; לא נדרש להעלאה עצמה).

## 4. שלב א' — מיגרציות למסד (חובה לפני ההעלאה)

> **מצב: בוצע.** ראה סעיף 1. הסעיף נשאר כהפניה: לסביבה חדשה, לשחזור, ולמיגרציות עתידיות (0004 ואילך).

**למה קודם:** הקוד משתמש בטבלאות ובאינדקס `idx_prices_recent` שנוצרים במיגרציות. במסד לא ממוגר ה-Worker לא קורס: `/api/health` עדיין מחזיר 200 (הוא בודק רק חיבור), והחיפוש מתדרדר בשקט (המטמון וההיסטוריה לא נשמרים, ומגבלת הקצב עוברת לזיכרון של כל מופע). לכן מאמתים מיגרציות אך ורק בשאילתות SQL בסוף הסעיף, ולא לפי בדיקת הבריאות.

**סדר וחוקים:** `0001_init.sql` ← `0002_seed_airports.sql` ← `0003_cache_extras_and_recent_index.sql`.
- 0001 ו-0002 בטוחים להרצה חוזרת (`IF NOT EXISTS` / `INSERT OR REPLACE`).
- **0003 מכיל `ALTER TABLE … ADD COLUMN` ולכן חייב לרוץ פעם אחת בלבד** (הרצה שנייה נכשלת עם "duplicate column name").

**דרך 1 (מומלצת) — `wrangler` במסוף:**

```bash
git clone https://github.com/liorilay2004-source/eee
cd eee/worker
npm ci
npx wrangler login          # נפתח דפדפן לאישור (במחשב אישי)
npx wrangler d1 migrations apply eee-db --remote
```

ב-Codespaces או בכל סביבה מרוחקת `wrangler login` לא עובד (ה-callback מקומי). שם יוצרים טוקן API בהרשאות "Edit Cloudflare Workers" ו-"Account → D1 → Edit" ומגדירים אותו רק כמשתנה סביבה בטרמינל (`export CLOUDFLARE_API_TOKEN=…`, ללא כתיבה לקובץ), ואת ה-Account ID כ-`CLOUDFLARE_ACCOUNT_ID`.

`wrangler` מתעד ב-D1 אילו מיגרציות הורצו (טבלת `d1_migrations`), ולכן הרצה חוזרת בטוחה: הוא מריץ רק את החסרות (ואם אין חסרות: "No migrations to apply!"). לפני ההרצה הוא שואל אישור (`yes`), ומדפיס שלושה בלוקים, אחד לכל מיגרציה (20, 616 ו-3 פקודות). ההצלחה היא שבסוף כל שלוש השורות מסומנות ✅. הבלוק האחרון נראה כך (מקומית):

```
🚣 3 commands executed successfully.
│ 0001_init.sql                          │ ✅ │
│ 0002_seed_airports.sql                 │ ✅ │
│ 0003_cache_extras_and_recent_index.sql │ ✅ │
```

**דרך 2 — קונסולת D1 בדשבורד (בלי מסוף):** Storage & databases ← D1 ← `eee-db` ← Console; מדביקים כל קובץ לפי הסדר. הקובץ 0002 גדול (כ-127 KB), וייתכן שיידרש לפצל אותו. **אזהרה:** `wrangler` לא יידע שהמיגרציות הורצו, ומאוחר יותר `wrangler d1 migrations apply` ינסה להריץ שוב את 0003 ויכשל. לכן, בדרך הזו, מיד אחרי הדבקת שלושת הקבצים **רושמים אותם** ב-`d1_migrations` (בקונסולה):

```sql
CREATE TABLE IF NOT EXISTS d1_migrations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT UNIQUE,
  applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL
);
INSERT OR IGNORE INTO d1_migrations(name) VALUES
  ('0001_init.sql'), ('0002_seed_airports.sql'), ('0003_cache_extras_and_recent_index.sql');
```

אם דילגת על הרישום, יהיו במסד 11 טבלאות בלבד (בלי `d1_migrations`), ו-`wrangler` ינסה להריץ את 0003 שוב ויכשל.

**דרך 3 — דרך המחבר ל-Cloudflare (זו שנעשתה בפועל):** בוצעה באישור מפורש שלך, בכ-10 שאילתות: יצירת הטבלאות והזרעת 615 שדות התעופה. הרישום ב-`d1_migrations` נעשה בנפרד (13:58 UTC, שלוש רשומות באותה שנייה) ולא על ידי, ככל הנראה בהרצת `wrangler d1 migrations apply` שלך או של בנייה. כל הפקודות אידמפוטנטיות (`IF NOT EXISTS` / `INSERT OR REPLACE`), ו-0003 (`ALTER TABLE`) רצה פעם אחת בלבד.

**אימות אחרי המיגרציה** (בקונסולת D1 או `npx wrangler d1 execute eee-db --remote --command "…"`):

```sql
SELECT count(*) FROM airports;                                   -- צפוי: 615
SELECT count(DISTINCT city_iata) FROM airports;                  -- צפוי: 567
SELECT group_concat(name, ', ') FROM sqlite_master
  WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%';
-- צפוי: airports, fx_rates, bag_fees, searches, prices, users, watches, alerts,
--       source_health, search_cache, rate_limits (11 טבלאות של המערכת)
--       + d1_migrations (12 בסך הכול; אם הרצת בדרך 2 בלי לרשום, יש 11)
SELECT count(*) FROM pragma_table_info('search_cache') WHERE name='extra_json';  -- צפוי: 1
SELECT count(*) FROM sqlite_master WHERE name='idx_prices_recent';               -- צפוי: 1
SELECT name FROM d1_migrations ORDER BY id;   -- צפוי: 0001_init, 0002_seed_airports, 0003_cache_extras_and_recent_index
```

## 5. שלב ב' — העלאה

### דרך א' — Workers Builds (מהדשבורד, בלי מסוף; מומלץ אם אין מחשב)
1. https://dash.cloudflare.com ← **Workers & Pages** ← **Create application** ← **Get started** ליד **Import a repository**.
2. בוחרים חשבון Git (GitHub). אם מתבקש, מתקינים את אפליקציית Cloudflare על הריפו `eee`.
3. בוחרים את `eee` ומגדירים:

| שדה | ערך |
|---|---|
| Worker name | `eee-api` (**זהה ל-`name` ב-`wrangler.toml`**) |
| Git branch (production) | `main` |
| Root directory | `worker` |
| Build command | ריק |
| Deploy command | `npx wrangler deploy` (ברירת המחדל) |
| API token | ברירת המחדל (Cloudflare יוצר טוקן לבנייה) |

4. **Save and Deploy.** מהרגע הזה כל דחיפה ל-`main` מעלה גרסה חדשה אוטומטית.
5. ב-Settings ← Builds לבדוק שבנייה לענפים שאינם ייצור **כבויה**. כשהיא דולקת, כל ענף ו-PR מקבלים בנייה נפרדת (`wrangler versions upload` / preview), וזה לא מה שרצוי כאן.

שים לב: Workers Builds **לא מריץ מיגרציות**. את שלב א' עושים בנפרד, לפני ההעלאה הראשונה.

### דרך ב' — `wrangler` במסוף

```bash
cd eee/worker      # רק אם אינך כבר בתיקיית worker (למשל מסעיף 4)
npm ci
npx wrangler deploy
```

בסוף מודפסת הכתובת `https://eee-api.<…>.workers.dev`.

### דרך ג' — GitHub Actions
לא נוצר workflow להעלאה: מערכת ההרשאות חסמה אותו כ"Production Deploy", וביקשת לטפל ב-Cloudflare בעצמך. אם תרצה אותו, תגיד. הוא ידרוש שני סודות ב-GitHub: `CLOUDFLARE_API_TOKEN` (התבנית "Edit Cloudflare Workers" בתוספת "Account → D1 → Edit") ו-`CLOUDFLARE_ACCOUNT_ID`.

## 6. שלב ג' — סודות ומשתנים

בדשבורד: Workers & Pages ← `eee-api` ← **Settings** ← **Variables and Secrets** ← **Add**. **בוחרים בסוג "Secret"**, לא "Text". אחרי שהוספת את שלושת הסודות לוחצים **Deploy**, אחרת הם לא נכנסים לתוקף וחיפוש ימשיך להחזיר 503 (בפקודת `wrangler secret put` ההחלה מיידית).

או במסוף (הערך נשאל אינטראקטיבית ולא נשמר בהיסטוריית הפקודות):

```bash
cd eee/worker      # רק אם אינך כבר בתיקיית worker
npx wrangler secret put TRAVELPAYOUTS_TOKEN
npx wrangler secret put TRAVELPAYOUTS_MARKER
npx wrangler secret put RATE_LIMIT_SALT      # מחרוזת אקראית של 32 תווים ומעלה. למשל: openssl rand -hex 32
```

- סודות (Secret) לא נמחקים בהעלאה חדשה.
- **משתנים רגילים (Text) שהוגדרו רק בדשבורד עלולים להימחק בהעלאה הבאה**, כי `wrangler.toml` הוא מקור האמת שלהם. לכן `ALLOWED_ORIGIN` יוגדר בקובץ `wrangler.toml` (ב-`[vars]`) כשיהיה ממשק, ולא בדשבורד.

## 7. שלב ד' — אימות (מחליפים `URL` בכתובת שלך)

כל הפלטים כאן נבדקו מקומית; ב-Cloudflare הם אמורים להיות זהים. הבדיקות מסודרות כך שאפשר לבצע אותן לפי הסדר; **את בדיקה 3 מריצים בין סעיף 5 לסעיף 6 (לפני הגדרת הסודות)**, ואת בדיקה 6 (מגבלת הקצב) אחרונה.

```bash
URL=https://eee-api.<שלך>.workers.dev

# 1) בריאות (בודק חיבור ל-D1 בלבד, לא שהמיגרציות הורצו: אותן מאמתים ב-SQL, סעיף 4)
curl -i $URL/api/health
#   HTTP 200, Cache-Control: no-store, X-Content-Type-Options: nosniff
#   {"status":"ok","db":"ok"}

# 2) השלמה אוטומטית בעברית
curl -G $URL/api/airports --data-urlencode "q=ברצלונה"
#   {"results":[{"code":"BCN","nameHe":"ברצלונה","nameEn":"Barcelona","countryCode":"ES","kind":"city","airports":["BCN"]}]}

# 3) חיפוש בלי טוקן של Travelpayouts (מצב צפוי לפני שסעיף 6 הושלם).
#    התאריכים חייבים להיות עתידיים (עד 365 יום), לכן מחושבים: 30 ו-45 ימים קדימה
#    (במק: date -v+30d +%F). אם כבר הגדרת סודות, צפה ל-200, או ל-503 מסיבה אחרת (wrangler tail).
S=$(date -d '+30 days' +%F); E=$(date -d '+45 days' +%F)
curl -i -X POST $URL/api/search -H 'content-type: application/json' \
  -d "{\"origin\":\"תל אביב\",\"destination\":\"ברצלונה\",\"windowStart\":\"$S\",\"windowEnd\":\"$E\",\"stayMin\":5,\"stayMax\":7}"
#   HTTP 503  {"error":{"code":"source_unavailable","message":"No fare source is available right now"}}
#   (התשובה הזו מניחה ששער החליפין נטען. אם גם בנק ישראל וגם open.er-api.com לא נגישים, הקוד הוא fx_unavailable)
#   אחרי שהוגדר TRAVELPAYOUTS_TOKEN: HTTP 200 עם "cards" ו-"meta".
#   המבנה המדויק של התשובה מוגדר ב-worker/src/types.ts (SearchResponse). ב-docs/WEB_APP_SPEC.md §7.2
#   מתואר החוזה העתידי, עם שדות נוספים שעדיין אינם ב-Worker.

# 4) שגיאת קלט
curl -i -X POST $URL/api/search -H 'content-type: application/json' \
  -d '{"origin":"TLV","destination":"BCN","windowStart":"2020-01-01","windowEnd":"2020-01-05","stayMin":5,"stayMax":7}'
#   HTTP 400  {"error":{"code":"invalid_request",...,"fields":{"windowStart":"must not be in the past",...}}}

# 5) שיטה שגויה / נתיב לא קיים / גוף גדול מדי
curl -i $URL/api/search            # 405 + Allow: POST, OPTIONS
curl -i $URL/nope                  # 404
# גוף של יותר מ-8192 בתים -> 413 {"error":{"code":"payload_too_large",...}} (רק עם כותרת JSON; בלעדיה: 415)
head -c 9000 /dev/zero | tr '\0' a > /tmp/big.txt
curl -i -X POST $URL/api/search -H 'content-type: application/json' --data-binary @/tmp/big.txt

# 6) מגבלת קצב: 30 בקשות POST ל-/api/search ב-10 דקות ללקוח (כולל בקשות שנדחות ב-400, ובדיקות 3-5 שכבר בוצעו).
#    אחרי בדיקות 3-5 ה-429 יגיע כבר בבקשה ה-28 בערך. אחריה החיפוש חסום לכתובת שלך עד ~10 דקות (Retry-After),
#    לכן זו הבדיקה האחרונה: אל תבדוק חיפוש אמיתי מיד אחריה.
for i in $(seq 1 31); do curl -s -o /dev/null -w "%{http_code} " -X POST $URL/api/search -H 'content-type: application/json' -d '{}'; done
#   צפוי: 400 עד שהמכסה נגמרת, ואז 429 עם Retry-After ו-{"error":{"code":"rate_limited",...}}. מספיק שיופיע 429 בתוך הלולאה
```

בדיקות נוספות בדשבורד:
- **Cron:** Workers & Pages ← `eee-api` ← Settings ← **Triggers** ← **Cron Triggers**: רואים `17 3 * * *` (UTC). היסטוריית הרצות (Trigger Events ← View events) מתמלאת רק אחרי ההרצה הראשונה ב-03:17 UTC, ולעיתים עד 30 דקות אחרי יצירת ה-Worker.
- **יומן חי:** `npx wrangler tail eee-api` (או לשונית Logs בדשבורד).
- **אין CORS עד שמגדירים `ALLOWED_ORIGIN`:** תשובת OPTIONS היא 204 בלי כותרות `Access-Control-*`. זה מכוון.

**כיסוי הנתונים (השער D1 באפיון):** אחרי שיש טוקן, מריצים את Phase 0 לכמה מסלולים מתל אביב ומאילת (GitHub ← Actions ← "Phase 0 - price proof" ← Run workflow) ובודקים ש-Travelpayouts מחזיר מחירים. **ה-workflow קורא את הטוקן מסודות של GitHub, לא מ-Cloudflare:** לפני ההרצה מוסיפים ב-GitHub ← Settings ← Secrets and variables ← Actions את `TRAVELPAYOUTS_TOKEN` (ואת `TRAVELPAYOUTS_MARKER` אם יש). בלי זה ההרצה מסתיימת "בהצלחה" בלי נתוני Travelpayouts, ולכן בסיכום ההרצה מוודאים שהמקור `travelpayouts` פעיל. זו השאלה הפתוחה החוסמת של הפרויקט.

## 8. מגבלות ועלויות (מסלול חינמי)

מהתיעוד הרשמי של Cloudflare, נכון ל-2026-09-29:

| מגבלה | ערך | מה קורה בחריגה |
|---|---|---|
| בקשות ל-Workers | 100,000 ליום (מתאפס בחצות UTC) | שגיאה 1027 עד החצות |
| זמן CPU לבקשה | 10 ms | שגיאה 1102 לאותה בקשה |
| קריאות fetch יוצאות לבקשה | 50 (לשירותי Cloudflare כמו D1: 1,000) | הקוד מגביל את עצמו ל-30 קריאות ל-Travelpayouts |
| D1: קריאות וכתיבות שורות ביום | מגבלה יומית, נאכפת מ-2026-09-01 | **שאילתות נכשלות עד חצות UTC**, הנתונים לא נפגעים, ואתה מקבל מייל התראה |

- **אין חיוב אוטומטי במסלול החינמי.** מעבר למסלול בתשלום הוא פעולה ידנית שלך.
- **הערכות של הקוד (לא נמדדו בייצור):** חיפוש חדש כותב בערך 190 שורות, והצלחה מהמטמון בערך 5. במגבלת הכתיבה היומית זה בערך 500 חיפושים חדשים ביום. מעבר לכך החיפושים ייכשלו עד חצות UTC.
- **סיכון CPU:** לא נמדד בלי נתוני Travelpayouts אמיתיים. אם תראה שגיאות 1102 בדשבורד, האפשרויות: להקטין את `limit` בשאילתות ל-Travelpayouts (שינוי קוד שאעשה), או מסלול בתשלום. ההחלטה שלך.

## 9. תפעול

- **ניטור:** Workers & Pages ← `eee-api` ← Metrics (בקשות, שגיאות, זמן CPU); D1 ← `eee-db` ← Metrics.
- **גיבוי גרסה קודמת (Rollback):** `eee-api` ← **Deployments** ← שלוש נקודות ליד גרסה קודמת ← **Rollback** (עד 100 גרסאות אחרונות). או `npx wrangler rollback`. **הנתונים ב-D1 לא חוזרים אחורה**, וההעלאה של קוד שתלוי במבנה מסד חדש דורשת זהירות.
- **שחזור מסד:** ל-D1 יש שחזור לנקודת זמן (Time Travel), במסוף: `npx wrangler d1 time-travel info eee-db` ו-`... restore`. תקופת השמירה נקבעת לפי המסלול (במסלול החינמי 7 ימים, לפי התיעוד הרשמי). בדוק אותה לפני שאתה מסתמך על כך.
- **אל תמחק את `eee-db`:** בו נשמר היסטוריית המחירים והמטמון.

## 10. אבטחה

- אין סודות בריפו (נבדק בסריקה לפני כל דחיפה), וקובץ `worker/.dev.vars` מוחרג ב-`.gitignore`.
- הריפו ציבורי: אם טוקן נחשף בטעות, **מבטלים אותו מיד** ויוצרים חדש.
- טוקן API (אם תשתמש בדרך ג'): בהרשאות מינימום, בחשבון הספציפי, וניתן לביטול בכל רגע.
- `RATE_LIMIT_SALT` חייב להיות סוד, ובכתובות לקוחות נשמרת רק גיבוב מולח (לא כתובת גולמית).
- כתובת `workers.dev` היא ציבורית: כל אחד יכול לקרוא ל-API, ולכן מגבלת הקצב חשובה.

## 11. קריטריוני קבלה — "העלאה הושלמה" כש:

- [x] ב-D1 יש 12 טבלאות (11 של המערכת + `d1_migrations`; 11 אם המיגרציות הורצו בקונסולה בלי רישום) ו-615 שדות תעופה. **בוצע ואומת ב-2026-09-29.**
- [ ] `GET /api/health` מחזיר 200 עם `{"status":"ok","db":"ok"}`.
- [ ] `GET /api/airports?q=ברצלונה` מחזיר את BCN.
- [ ] `POST /api/search` מחזיר 503 `source_unavailable` לפני הגדרת הטוקן, ו-200 עם כרטיסים אחריה.
- [ ] אחרי 30 בקשות POST בחלון של 10 דקות, הבאה מחזירה 429 עם `Retry-After` (בלולאה של בדיקה 6 מופיע 429).
- [ ] ה-Cron `17 3 * * *` מופיע ב-Settings ← Triggers ← Cron Triggers.
- [ ] שלושת הסודות (Secret) מוגדרים, ואין אף אחד מהם בריפו.
- [ ] יש דרך ל-Rollback (יש לפחות שתי גרסאות ב-Deployments).

**פלט סופי (לפי סעיף 18 באפיון הראשי), כשתסיים:**

```
GitHub: https://github.com/liorilay2004-source/eee
Commit: <SHA של הקומיט שהועלה>
Cloudflare: Worker eee-api + D1 eee-db
LIVE URL: <הכתובת המאומתת>
```

**מה אעשה בשבילך בלי לגעת ב-Cloudflare:** כשתשלח לי את הכתובת, אריץ עליה את בדיקות סעיף 7 (בקשות קריאה בלבד) ואדווח מה עבר.

## 12. פתרון תקלות

| תסמין | סיבה סבירה | פתרון |
|---|---|---|
| בנייה ב-Workers Builds נכשלת על שם | ה-Worker בדשבורד לא נקרא `eee-api` | לתקן את השם בדשבורד כך שיהיה זהה ל-`name` ב-`worker/wrangler.toml` |
| `/api/health` מחזיר 503 `{"status":"degraded","db":"error"}` | אין חיבור ל-D1: binding חסר, `database_id` שגוי, או תקלה ב-D1 | לוודא ב-`wrangler.toml` שה-`database_id` נכון ושה-binding נקרא `DB` |
| `/api/health` תקין, אבל החיפוש לא שומר מטמון והיומן מדווח `rate limiter storage unavailable` | המיגרציות לא הורצו (הבריאות לא בודקת טבלאות) | להריץ שלב א' ולאמת ב-SQL |
| `wrangler d1 migrations apply` נכשל עם "duplicate column name" | 0003 הורצה ידנית ולא נרשמה ב-`d1_migrations` | לרשום: `npx wrangler d1 execute eee-db --remote --command "INSERT OR IGNORE INTO d1_migrations(name) VALUES ('0003_cache_extras_and_recent_index.sql')"` (ואם צריך גם 0001 ו-0002), ואז להריץ שוב `apply`: אמור להדפיס "No migrations to apply!" |
| `/api/search` מחזיר 503 `source_unavailable` | אין `TRAVELPAYOUTS_TOKEN`, הסוד לא הופעל (חסר Deploy בדשבורד), או שהמקור נכשל | להגדיר את הסוד ולהפעיל (סעיף 6); לבדוק `wrangler tail` |
| `/api/search` מחזיר 503 עם `code: fx_unavailable` | שני מקורות שערי החליפין (בנק ישראל, open.er-api.com) לא נגישים ואין שערים שמורים | לנסות שוב אחרי דקה; לבדוק `wrangler tail` |
| שגיאה 1102 | חריגת CPU של 10 ms | ראה סעיף 8 |
| שאילתות D1 נכשלות עם "Your account has exceeded D1's free tier daily row read limit" (או "write limit") | חריגה ממכסת D1 היומית | ממתינים לחצות UTC, או מסלול בתשלום |
| קריאה מהדפדפן נחסמת ב-CORS | `ALLOWED_ORIGIN` לא מוגדר (בכוונה) | נדרש רק בשלב 2: מגדירים ב-`wrangler.toml` |

## 13. החלטות שלך

| החלטה | המלצה |
|---|---|
| דרך העלאה: א' (Workers Builds), ב' (מסוף), או ג' (GitHub Actions, בהרשאתך) | א' אם אין מחשב זמין; ב' אם יש |
| איך מריצים את המיגרציות | **הוחלט ובוצע** (דרך 3). למיגרציות עתידיות: דרך 1 |
| מסלול חינמי או בתשלום אם יימצא סיכון CPU/כתיבות | להישאר בחינמי עד שנמדוד |
| דומיין מותאם ושם מוצר | אחרי שלב 2 |
| הזמן להעלות: לפני או אחרי בדיקת כיסוי הנתונים של Travelpayouts | **הכלל בפרויקט (README, ואפיון האתר W0(d)/D15): אין העלאה ל-Cloudflare לפני ש-Phase 0 מוכיח שהמקורות עובדים למסלולים מישראל.** ההמלצה: קודם טוקן ו-Phase 0, ורק אחרי שהשער עבר להעלות. אם אתה מחליט להעלות קודם, זו עקיפה מודעת של הכלל, ועדיין אין ערך בלי טוקן (חיפוש יחזיר 503) |
