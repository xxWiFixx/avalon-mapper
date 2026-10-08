# Russian and English interfaces

Choose **Settings → Other → Language** (Russian: **Настройки → Прочее → Язык**).
The preference is saved in the active profile. Every open overlay, statistics window,
search window and region picker reloads in the selected language. Maps, accounts,
capture settings and the current statistics session are preserved. The settings
window returns to the language selector after the change.

Fresh installations use Russian on Russian Windows and English on other systems.
Existing profiles retain Russian until a language is selected. The temporary second
account inherits the language when its profile is first created, then stores its
own preference independently.

`app/lib/i18n.js` is shared by native messages and renderers. Russian source messages
are stable keys in `app/locales/en.js`; variable values use numbered placeholders.
Static document translation runs before controllers insert user data. Nicknames,
map names, portal names and game protocol identifiers are never automatically
translated. Mob and weapon labels use the official Albion English catalogue only
when presented; stored statistics retain their original identities.

For local renderer previews, append `?lang=en` or `?lang=ru`. Preview links do not
write the installed application's preference.

The landing page has a separate React language context. `/en/` is an English entry
page with English metadata and content even without JavaScript. The RU / EN control
updates the page, persists the choice and maintains a shareable `?lang=` URL.
English screenshots are fresh renders at 5760 pixels wide, exported at 960, 1920
and 3840 pixels. Russian screenshots and existing motion design are preserved.

Checks: `node --test app/test/i18n.test.js`, `node app/test/i18n-native-smoke.js`,
and `node tools/localization-review.cjs` with Playwright in `NODE_PATH`.

The site's planned prices are **$2.99 USD/month** for unlimited automatic captures
and **$8.99 USD/month** for a private group map including one unlimited capture seat. Russian prices remain 199 RUB/month and 799 RUB/month.
The free plan will allow 10 successful new automatic captures per person per day,
across all maps. Failed recognition and rechecks will not count. Manual entries
remain unlimited; portal expiry times remain accurate. Personal cloud maps remain private;
group uploads are optional. Payments and quotas are not implemented in this release. The page labels these
plans as coming soon and links to the current privacy documentation.
