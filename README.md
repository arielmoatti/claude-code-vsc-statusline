# Claude Code Statusline

תוסף קליל ל-VS Code שמציג את **אחוזי השימוש בסשן** ואת **שעות השיא** של Claude Code ישירות בשורת הסטטוס.

![Status Bar](screenshot.jpg)

## מה מוצג

| פריט | מתי מוצג | דוגמה |
|------|----------|-------|
| **שימוש 5 שעות** | תמיד (כשמחוברים) | `5h \| 47% ████░░░░ ⟳2h 05m (17:35)` |
| **שימוש 7 ימים** | רק מעל 50% | `7d \| 62% █████░░░` |
| **שעות שיא** | תמיד | `✓ Off-Peak` או `🔥 Peak — 2h 05m left` |

- אחוזי השימוש נשלפים מ-OAuth API של Anthropic (אותו טוקן שכבר קיים ב-Claude Code)
- לוח זמני שעות השיא נטען מ-[Nadav-Fux/claude-2x-statusline](https://github.com/Nadav-Fux/claude-2x-statusline)
- רענון אוטומטי כל 30 שניות (ניתן להגדרה)
- פורמט שעון 24H

## התקנה

### התקנה מהירה (העתיקו כפרומפט לקלוד)

> התקן את התוסף Claude Code Statusline מתוך קוד מקור:
>
> ```
> git clone https://github.com/arielmoatti/claude-code-vsc-statusline.git
> cd claude-code-vsc-statusline
> npm install
> npm run compile
> npx @vscode/vsce package
> code --install-extension claude-code-vsc-statusline-0.1.0.vsix
> ```

### התקנה ידנית

1. שכפלו את הריפו
2. `npm install && npm run compile`
3. `npx @vscode/vsce package`
4. ב-VS Code: Extensions > `...` > Install from VSIX > בחרו את קובץ ה-`.vsix`

## הגדרות

| הגדרה | ברירת מחדל | תיאור |
|-------|-----------|-------|
| `claudeStatusline.refreshInterval` | `30` | תדירות רענון בשניות |
| `claudeStatusline.showRateLimits` | `true` | הצגת שימוש 5h / 7d |
| `claudeStatusline.showPeakHours` | `true` | הצגת שעות שיא |

## דרישות

- **Claude Code** מותקן ומחובר (התוסף קורא את טוקן ה-OAuth הקיים)
- אין צורך במפתחות API נוספים

## קרדיט

מבוסס על [claude-2x-statusline](https://github.com/Nadav-Fux/claude-2x-statusline) מאת [Nadav Fux](https://github.com/Nadav-Fux). גרסה מופשטת ומעוצבת מחדש.

## רישיון

AGPL-3.0 (כמו המקור)
