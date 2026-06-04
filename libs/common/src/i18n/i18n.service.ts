/* eslint-disable @typescript-eslint/no-unsafe-assignment */
import { Injectable } from '@nestjs/common';
import * as fs from 'fs';
import * as path from 'path';

@Injectable()
export class I18nService {
  private translations: Map<string, Map<string, string>> = new Map();

  constructor() {
    this.loadTranslations();
  }

  private loadTranslations() {
    const languages = ['fr', 'en', 'sw'];
    let basePath = path.join(
      process.cwd(),
      'libs',
      'common',
      'src',
      'i18n',
      'locales',
    );
    if (!fs.existsSync(basePath)) {
      basePath = path.join(
        process.cwd(),
        'dist',
        'libs',
        'common',
        'src',
        'i18n',
        'locales',
      );
    }
    console.log('[I18nService] Loading translations from:', basePath);
    for (const lang of languages) {
      const langMap = new Map<string, string>();
      const langDir = path.join(basePath, lang);
      if (fs.existsSync(langDir)) {
        const files = fs.readdirSync(langDir);
        for (const file of files) {
          if (file.endsWith('.json')) {
            const filePath = path.join(langDir, file);
            try {
              const content = fs.readFileSync(filePath, 'utf-8');
              const json = JSON.parse(content);
              for (const [key, value] of Object.entries(json)) {
                langMap.set(key, value as string);
              }
              console.log(
                `[I18nService] Loaded ${Object.keys(json).length} keys from ${file}`,
              );
            } catch (err) {
              console.error(
                `[I18nService] Error parsing JSON file: ${filePath}`,
                err.message,
              );
              // Optionnel : rejeter l'erreur ou continuer
            }
          }
        }
        console.log(
          `[I18nService] Total ${langMap.size} keys for language: ${lang}`,
        );
      } else {
        console.warn(`[I18nService] Language directory not found: ${langDir}`);
      }
      this.translations.set(lang, langMap);
    }
  }

  translate(
    key: string,
    lang: string = 'fr',
    params?: Record<string, any>,
  ): string {
    const langMap = this.translations.get(lang);
    let text = langMap?.get(key) || key;
    if (params) {
      for (const [k, v] of Object.entries(params)) {
        text = text.replace(new RegExp(`{{${k}}}`, 'g'), v);
      }
    }
    return text;
  }
}
