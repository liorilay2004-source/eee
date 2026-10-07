import { useEffect } from "react";
import { ArrowRight, Compass } from "lucide-react";
import { SiteFooter, SiteHeader } from "./components/Chrome";
import { AccessGate } from "./components/LockScreen";
import { SearchPage } from "./pages/SearchPage";
import { ExplorePage } from "./pages/ExplorePage";
import { DealsPage } from "./pages/DealsPage";
import { AlertsPage } from "./pages/AlertsPage";
import { OverlayPage } from "./pages/OverlayPage";
import { PRODUCT_NAME } from "./config";

const pages = {
  "/privacy": { title: "מדיניות פרטיות", kicker: "המידע שלכם נשאר בשליטתכם", updated: "30 בספטמבר 2026", sections: [
    ["איזה מידע נשלח", "כשמבצעים חיפוש, פרטי החיפוש — מוצא, יעד, תאריכים, מספר נוסעים והעדפות — נשלחים לשירות כדי לבדוק מחירים. המערכת אינה דורשת חשבון או כתובת דוא״ל."],
    ["שמירה במכשיר", "החיפוש האחרון יכול להישמר בדפדפן במכשיר שלכם כדי למלא את הטופס בפעם הבאה. אפשר למחוק אותו באמצעות מחיקת נתוני האתר בהגדרות הדפדפן. כשהאתר נעול לשימוש אישי, גם מפתח הגישה שהזנתם נשמר בדפדפן הזה (localStorage, בשם eee.accessKey; בגלישה פרטית הוא נמחק לכל המאוחר כשסוגרים את החלון הפרטי). הוא נשלח רק לשרת של האתר, בכותרת של כל בקשה ולא בכתובת, ונמחק בלחיצה על ״יציאה (מחיקת המפתח מהמכשיר)״ בתחתית העמוד."],
    ["שמירה בשרת", "פרטי חיפוש ותוצאות עשויים להישמר במסד הנתונים של המערכת לצורך הצגת תוצאות, מטמון והשוואת מחירים. לצורך מניעת שימוש לרעה נשמר מזהה מגובב ומלוח, ולא כתובת IP גולמית."],
    ["ספקים חיצוניים", "בקשות חיפוש מועברות לתשתית Cloudflare ולמקורות מחירי הטיסות כאשר הם מופעלים. לחיצה על קישור הזמנה תעביר אתכם לאתר של ספק חיצוני, שמדיניות הפרטיות שלו חלה שם."],
    ["עוגיות ופרסום", "גרסת התצוגה אינה משתמשת בעוגיות של המערכת, בכלי מעקב או בסקריפטים של פרסום. אין בה חשבונות משתמשים."],
    ["התוסף לדפדפן", "התוסף (למי שהתקין אותו) קורא רק את מה שהקלדתם בחיפוש של Google וב־Google Flights: מילות החיפוש שבכתובת הדף, ובגוגל טיסות גם את המסלול והתאריכים שבכתובת או בכותרת. הוא לא קורא את תוכן הדף ולא את המחירים של גוגל. לשירות נשלחים רק קוד שדה התעופה ביציאה, קוד היעד (או בקשה ליעדים זולים) והחודש, בלי מילות החיפוש, בלי כתובת הדף, בלי עוגיות ובלי מזהה. כשאין מחיר שמור, השירות שואל את מקור המחירים על המסלול והחודש בלבד. הגדרות התוסף (מופעל או כבוי, שדה היציאה, היכן הוסתר) נשמרות באחסון הסנכרון של הדפדפן, ואם הסנכרון פעיל הן עוברות לחשבון הדפדפן שלכם. אין בתוסף סטטיסטיקות או מעקב."],
  ] },
  "/terms": { title: "תנאי שימוש", kicker: "מידע לפני שמתחילים", updated: "29 בספטמבר 2026", sections: [
    ["מה השירות עושה", "המערכת מחפשת ומשווה מידע על טיסות ומפנה לאתרי הזמנה חיצוניים. היא אינה מוכרת כרטיסים, אינה מבצעת הזמנות ואינה צד לעסקה מול חברת התעופה או ספק ההזמנה."],
    ["מחירים וזמינות", "מחירים, זמינות, שעות, עצירות ותנאי כבודה עשויים להשתנות. המידע שמוצג הוא נקודת התחלה לבדיקה; יש לאמת את כל הפרטים והמחיר הסופי באתר הספק לפני רכישה."],
    ["הצעות והערכות", "המערכת מציינת כאשר נתון אינו ידוע או כאשר המחיר משוער. המלצות מבוססות על המידע שמקורות הנתונים החזירו בזמן החיפוש ואינן התחייבות למחיר או לזמינות."],
    ["הזמנה וביטול", "כל הזמנה מתבצעת ישירות מול הספק. תנאי תשלום, שינוי, ביטול, כבודה ושירות לקוחות נקבעים על ידי אותו ספק."],
  ] },
  "/affiliate": { title: "גילוי נאות על קישורי הזמנה", kicker: "שקיפות גם בדרך להזמנה", updated: "30 בספטמבר 2026", sections: [
    ["קישורים מסחריים", "חלק מקישורי ההזמנה עשויים להיות קישורי שותפים. אם תתבצע הזמנה דרך קישור כזה, מפעילי המערכת עשויים לקבל עמלה, ללא תוספת מחיר מצד הספק — בהתאם לתנאי תוכנית השותפים."],
    ["איך זה משפיע על ההמלצות", "ההמלצות מדורגות לפי נתוני המחיר וההעדפות שבחרתם. קישור שותפים אינו מבטיח מחיר, ואינו מחליף השוואה ובדיקה באתר ההזמנה."],
    ["בתוסף לדפדפן", "גם כפתור ״להזמנה״ בכרטיס של התוסף עשוי להיות קישור שותפים. כשהוא כזה, הכרטיס אומר זאת מתחת לכפתורים."],
  ] },
  "/accessibility": { title: "נגישות", kicker: "האתר מיועד לכולם", updated: "29 בספטמבר 2026", sections: [
    ["מה נעשה", "הממשק נבנה בעברית ובכיווניות מימין לשמאל. כל שאלה בחיפוש נפתחת בחלון ממוקד שאפשר לסגור במקש Escape, יש ניווט מלא במקלדת עם סימון מיקוד בולט, הודעות טעינה, תוצאות ושגיאות מוכרזות לקוראי מסך, ניגודיות צבעים לפי AA, מטרות מגע של 44 פיקסלים לפחות, ותמיכה בהעדפת ״פחות תנועה״. העיצוב הבהיר אחיד בכל עמודי האתר."],
    ["מצב הבדיקה", "זוהי גרסת תצוגה מוקדמת. בדיקות נגישות מלאות עם קוראי מסך ומכשירים אמיתיים עדיין נדרשות לפני השקה. אם נתקלתם בקושי, אפשר לדווח לבעל המערכת דרך הערוץ שממנו קיבלתם את הקישור."],
  ] },
} as const;

type LegalPath = keyof typeof pages;

function LegalPage({ path }: { path: LegalPath }) {
  const page = pages[path];
  useEffect(() => { document.title = `${page.title} · ${PRODUCT_NAME}`; }, [page.title]);
  return <div className="app">
    <SiteHeader><a className="header-link" href="/"><ArrowRight size={18} aria-hidden="true" />חזרה<span className="narrow-hide"> לחיפוש</span></a></SiteHeader>
    <main id="main" className="main legal">
      <article className="legal-card">
        <p className="kicker">{page.kicker}</p>
        <h1>{page.title}</h1>
        <p className="legal-updated">עודכן לאחרונה: {page.updated}</p>
        <p className="legal-notice">עמוד זה הוא טיוטת תצוגה מקדימה. יש להשלים בדיקה ועדכון לפני השקה לציבור.</p>
        {page.sections.map(([heading, content]) => <section key={heading}><h2>{heading}</h2><p>{content}</p></section>)}
        <section><h2>גרסת המערכת</h2><p>{PRODUCT_NAME} היא מערכת מידע לחיפוש טיסות. השם והנוסחים בעמוד זה זמניים, ופרטי מפעיל ויצירת קשר יתווספו לפני השקה מלאה.</p></section>
        <section><h2>קרדיט למקורות מידע</h2><p>המידע על חגים ומועדים בישראל מבוסס על נתוני <a href="https://www.hebcal.com/" target="_blank" rel="noopener noreferrer">Hebcal.com</a>, המופצים ברישיון <a href="https://creativecommons.org/licenses/by/4.0/deed.he" target="_blank" rel="noopener noreferrer">Creative Commons ייחוס 4.0 בינלאומי (CC BY 4.0)</a>. הנתונים עובדו לתצוגה (למשל הסרת ניקוד), ואין בכך כדי לרמוז ש־Hebcal.com תומכת בשירות.</p><p>שמות המדינות והמטבעות בעברית מבוססים על <a href="https://cldr.unicode.org/" target="_blank" rel="noopener noreferrer">Unicode CLDR</a>, בכפוף ל<a href="https://www.unicode.org/license.txt" target="_blank" rel="noopener noreferrer">רישיון Unicode גרסה 3</a> (Copyright © 2004-2026 Unicode, Inc.).</p></section>
      </article>
    </main>
    <SiteFooter />
  </div>;
}

function NotFound() {
  useEffect(() => { document.title = `העמוד לא נמצא · ${PRODUCT_NAME}`; }, []);
  return <div className="app">
    <SiteHeader />
    <main id="main" className="main legal">
      <div className="state state-neutral">
        <div className="state-icon"><Compass size={24} aria-hidden="true" /></div>
        <h1>לא מצאנו את העמוד הזה</h1>
        <p>ייתכן שהקישור ישן או שגוי.</p>
        <div className="state-actions"><a className="btn btn-primary" href="/">חזרה לחיפוש טיסות</a></div>
      </div>
    </main>
    <SiteFooter />
  </div>;
}

function Pages() {
  const path = location.pathname.replace(/\/+$/, "") || "/";
  if (Object.hasOwn(pages, path)) return <LegalPage path={path as LegalPath} />;
  if (path === "/explore") return <ExplorePage />;
  if (path === "/deals") return <DealsPage />;
  if (path === "/alerts") return <AlertsPage />;
  if (path === "/overlay") return <OverlayPage />;
  if (path !== "/") return <NotFound />;
  return <SearchPage />;
}

/** Every page sits behind the private-use lock's gate: with the lock on and no key, only the lock screen shows. */
export default function App() {
  return <AccessGate><Pages /></AccessGate>;
}
