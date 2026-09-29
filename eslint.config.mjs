export default [{
    ignores: ["node_modules/**", ".vscode-test/**", "**/.vscode-test/**"],
}, {
    files: ["**/*.js"],
    languageOptions: {
        globals: {
            // CommonJS (extension.js 与 src/*.js 都是 CJS)
            require: "readonly",
            module: "writable",
            exports: "writable",
            __dirname: "readonly",
            __filename: "readonly",
            process: "readonly",
            console: "readonly",
            Buffer: "readonly",
            setTimeout: "readonly",
            clearTimeout: "readonly",
            setInterval: "readonly",
            clearInterval: "readonly",
            setImmediate: "readonly",
            URL: "readonly",
            TextEncoder: "readonly",
            TextDecoder: "readonly",
            global: "readonly",
            // mocha（TDD interface）
            suite: "readonly",
            test: "readonly",
            setup: "readonly",
            teardown: "readonly",
            suiteSetup: "readonly",
            suiteTeardown: "readonly",
        },
        ecmaVersion: 2022,
        sourceType: "commonjs",
    },

    rules: {
        "no-const-assign": "warn",
        "no-this-before-super": "warn",
        "no-undef": "warn",
        "no-unreachable": "warn",
        "no-unused-vars": ["warn", { argsIgnorePattern: "^_" }],
        "constructor-super": "warn",
        "valid-typeof": "warn",
    },
}];
