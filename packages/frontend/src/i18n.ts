import i18n from 'i18next';
import LanguageDetector from 'i18next-browser-languagedetector';
import HttpBackend from 'i18next-http-backend';
import { initReactI18next } from 'react-i18next';

void i18n
	.use(HttpBackend)
	.use(LanguageDetector)
	.use(initReactI18next)
	.init({
		fallbackLng: 'en',
		supportedLngs: ['en', 'de'],
		ns: ['translation'],
		defaultNS: 'translation',
		backend: {
			loadPath: '/locales/{{lng}}/{{ns}}.json',
			// nginx caches /locales for an hour: without a version key an update's new JS
			// meets the previous release's translations and renders raw keys
			queryStringParams: { v: __APP_VERSION__ },
		},
		interpolation: { escapeValue: false },
		detection: {
			order: ['localStorage', 'navigator'],
			caches: ['localStorage'],
		},
	});

export default i18n;
