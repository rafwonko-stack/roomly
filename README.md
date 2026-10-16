# Roomly 1.5 — Email и пароль

Аккаунты создаёт администратор. Самостоятельная регистрация, телефонный вход и Google удалены из клиента.

Инструкция: [docs/EMAIL-ONLY.md](docs/EMAIL-ONLY.md). В Supabase необходимо отключить Allow new users to sign up и ненужные Auth Providers; облачные настройки автоматически не менялись.

config.js, существующая база, роли и бронирования не изменены. Дополнительная миграция для версии 1.5 не требуется.

Сборка: `npm run build`. Проверки: `npm run check`, `npm test`. Интеграционные проверки: `npm ci --prefix tests/integration`, затем `npm run test:integration`.
