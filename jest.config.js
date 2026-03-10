/** @type {import('jest').Config} */
module.exports = {
    testEnvironment: 'node',
    roots: ['<rootDir>/tests'],
    testPathIgnorePatterns: [
        '<rootDir>/tests/e2e.bot.test.ts',
        '<rootDir>/tests/services/responseMonitor.test.ts',
        '<rootDir>/tests/services/responseMonitor.stopButtonSelector.test.ts',
        '<rootDir>/tests/bot/refactorBaseline.test.ts',
    ],
    transform: {
        '^.+\\.ts$': '@swc/jest',
    },
    moduleNameMapper: {
        '^@/(.*)$': '<rootDir>/src/$1',
    },
};
