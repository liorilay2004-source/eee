import { useEffect } from "react";
import { ArrowRight, Plane } from "lucide-react";
import { SearchPage } from "./pages/SearchPage";
import { PRODUCT_NAME } from "./config";

const pages = {
  "/privacy": { title: "מדיניות פרטיות", kicker: "המידע שלכם נשאר בשליטתכם", updated: "29 בספטמבר 2026", sections: [
    ["איזה מידע נשלח", "כשמבצעים חיפוש, פרטי החיפוש — מוצא, יעד, תאריכים, מספר נוסעים והעדפות — נשלחים לשירות כדי לבדוק מחירים. המערכת אינה דורשת חשבון או כתובת דוא״ל."],
    ["שמירה במכשיר", "החיפוש האחרון יכול להישמר בדפדפן במכשיר שלכם כדי למלא את הטופס בפעם הבאה. אפשר למחוק אותו מהקישור ״מחקו חיפוש שמור במכשיר הזה״ בתחתית עמוד החיפוש."],
    ["שמירה בשרת", "פרטי חיפוש ותוצאות עשויים להישמר במסד הנתונים של המערכת לצורך הצגת תוצאות, מטמון והשוואת מחירים. לצורך מניעת שימוש לרעה נשמר מזהה מגובב ומלוח, ולא כתובת IP גולמית."],
    ["ספקים חיצוניים", "בקשות חיפוש מועברות לתשתית Cloudflare ולמקורות מחירי הטיסות כאשר הם מופעלים. לחיצה על קישור הזמנה תעביר אתכם לאתר של ספק חיצוני, שמדיניות הפרטיות שלו חלה שם."],
    ["עוגיות ופרסום", "גרסת התצוגה אינה משתמשת בעוגיות של המערכת, בכלי מעקב או בסקריפטים של פרסום. אין בה חשבונות משתמשים."],
  ] },
  "/terms": { title: "תנאי שימוש", kicker: "מידע לפני שמתחילים", updated: "29 בספטמבר 2026", sections: [
    ["מה השירות עושה", "המערכת מחפשת ומשווה מידע על טיסות ומפנה לאתרי הזמנה חיצוניים. היא אינה מוכרת כרטיסים, אינה מבצעת הזמנות ואינה צד לעסקה מול חברת התעופה או ספק ההזמנה."],
    ["מחירים וזמינות", "מחירים, זמינות, שעות, עצירות ותנאי כבודה עשויים להשתנות. המידע שמוצג הוא נקודת התחלה לבדיקה; יש לאמת את כל הפרטים והמחיר הסופי באתר הספק לפני רכישה."],
    ["הצעות והערכות", "המערכת מציינת כאשר נתון אינו ידוע או כאשר המחיר משוער. המלצות מבוססות על המידע שמקורות הנתונים החזירו בזמן החיפוש ואינן התחייבות למחיר או לזמינות."],
    ["הזמנה וביטול", "כל הזמנה מתבצעת ישירות מול הספק. תנאי תשלום, שינוי, ביטול, כבודה ושירות לקוחות נקבעים על ידי אותו ספק."],
  ] },
  "/affiliate": { title: "גילוי נאות על קישורי הזמנה", kicker: "שקיפות גם בדרך להזמנה", updated: "29 בספטמבר 2026", sections: [
    ["קישורים מסחריים", "חלק מקישורי ההזמנה עשויים להיות קישורי שותפים. אם תתבצע הזמנה דרך קישור כזה, מפעילי המערכת עשויים לקבל עמלה, ללא תוספת מחיר מצד הספק — בהתאם לתנאי תוכנית השותפים."],
    ["איך זה משפיע על ההמלצות", "ההמלצות מדורגות לפי נתוני המחיר וההעדפות שבחרתם. קישור שותפים אינו מבטיח מחיר, ואינו מחליף השוואה ובדיקה באתר ההזמנה."],
  ] },
  "/accessibility": { title: "נגישות", kicker: "האתר מיועד לכולם", updated: "29 בספטמבר 2026", sections: [
    ["מה נעשה", "הממשק נבנה בעברית ובכיווניות מימין לשמאל, עם ניווט מקלדת, תוויות לשדות, מצבי טעינה ושגיאה שניתנים להכרזה לקוראי מסך, וניגודיות ומטרות מגע מותאמות לנייד."],
    ["מצב הבדיקה", "זוהי גרסת תצוגה מוקדמת. בדיקות נגישות מלאות עם קוראי מסך ומכשירים אמיתיים עדיין נדרשות לפני השקה. אם נתקלתם בקושי, אפשר לדווח לבעל המערכת דרך הערוץ שממנו קיבלתם את הקישור."],
  ] },
} as const;

type LegalPath = keyof typeof pages;

function LegalPage({ path }: { path: LegalPath }) {
  const page = pages[path];
  useEffect(() => { document.title = `${page.title} — ${PRODUCT_NAME}`; }, [page.title]);
  return <main className="legal-shell text-start">
    <div className="legal-top"><a className="brand" href="/"><span className="brand-mark"><Plane size={17} /></span><span className="brand-name">{PRODUCT_NAME}<span className="brand-period">.</span></span></a><a className="legal-back" href="/"><ArrowRight size={15} />חזרה לחיפוש</a></div>
    <article className="legal-content"><span className="panel-kicker">{page.kicker}</span><h1>{page.title}</h1><span className="legal-updated">עודכן לאחרונה: {page.updated}</span>
      <div className="legal-notice">עמוד זה הוא טיוטת תצוגה מקדימה. יש להשלים בדיקה ועדכון לפני השקה לציבור.</div>
      {page.sections.map(([heading, content]) => <section key={heading}><h2>{heading}</h2><p>{content}</p></section>)}
      <h2>גרסת המערכת</h2><p>מסלול היא מערכת מידע לחיפוש טיסות. השם והנוסחים בעמוד זה זמניים, ופרטי מפעיל ויצירת קשר יתווספו לפני השקה מלאה.</p>
    </article>
    <nav className="legal-footer" aria-label="עמודים נוספים"><a href="/privacy">פרטיות</a><a href="/terms">תנאי שימוש</a><a href="/affiliate">גילוי נאות</a><a href="/accessibility">נגישות</a></nav>
  </main>;
}

function NotFound() {
  return <main className="not-found"><span className="brand-mark"><Plane size={19} /></span><h1>לא מצאנו את העמוד הזה</h1><a href="/">חזרה לחיפוש טיסות</a></main>;
}

export default function App() {
  const path = location.pathname.replace(/\/+$/, "") || "/";
  if (Object.hasOwn(pages, path)) return <LegalPage path={path as LegalPath} />;
  if (path !== "/") return <NotFound />;
  return <SearchPage />;
}
