import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import Parser from "tree-sitter";
import TreeSitterTypeScript from "tree-sitter-typescript";
import TreeSitterJavaScript from "tree-sitter-javascript";
const TypeScript = TreeSitterTypeScript.typescript;
const SKIP_DIRS = new Set([
    "node_modules",
    ".git",
    "dist",
    "build",
    "out",
    ".next",
    ".turbo",
    "coverage",
    ".coding-memory",
]);
const FUNCTION_NODE_TYPES = new Set([
    "function_declaration",
    "function_expression",
    "generator_function_declaration",
    "generator_function",
    "method_definition",
]);
function getDbPath(projectPath) {
    return path.join(projectPath, ".coding-memory", "ast-index.db");
}
function openDb(projectPath) {
    const dbDir = path.join(projectPath, ".coding-memory");
    fs.mkdirSync(dbDir, { recursive: true });
    const db = new Database(getDbPath(projectPath));
    db.pragma("journal_mode = WAL");
    db.exec(`
    CREATE TABLE IF NOT EXISTS files (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      file_path TEXT NOT NULL UNIQUE,
      file_name TEXT NOT NULL,
      indexed_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS functions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      file_id INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
      name TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS classes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      file_id INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
      name TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS imports (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      file_id INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
      source TEXT NOT NULL
    );
  `);
    return db;
}
function walkProjectFiles(projectPath) {
    const results = [];
    function walk(dir) {
        let entries;
        try {
            entries = fs.readdirSync(dir, { withFileTypes: true });
        }
        catch {
            return;
        }
        for (const entry of entries) {
            if (entry.isDirectory()) {
                if (SKIP_DIRS.has(entry.name))
                    continue;
                walk(path.join(dir, entry.name));
            }
            else if (entry.isFile()) {
                if (/\.(ts|js)$/.test(entry.name) && !entry.name.endsWith(".d.ts")) {
                    results.push(path.join(dir, entry.name));
                }
            }
        }
    }
    walk(projectPath);
    return results;
}
function nameOfNode(node) {
    if (!node)
        return null;
    return node.text;
}
function extractIdentifierFromLhs(node) {
    // For `const foo = () => {}` / `const foo = function () {}`, the
    // enclosing variable_declarator's `name` field holds the identifier.
    if (node.type === "identifier")
        return node.text;
    return null;
}
function extractFromSource(sourceCode, language) {
    const parser = new Parser();
    parser.setLanguage(language);
    const tree = parser.parse(sourceCode);
    const functions = [];
    const classes = [];
    const imports = [];
    function visit(node) {
        switch (node.type) {
            case "function_declaration":
            case "generator_function_declaration": {
                const name = nameOfNode(node.childForFieldName("name"));
                if (name)
                    functions.push(name);
                break;
            }
            case "method_definition": {
                const name = nameOfNode(node.childForFieldName("name"));
                if (name)
                    functions.push(name);
                break;
            }
            case "function_expression":
            case "generator_function":
            case "arrow_function": {
                const declaredName = nameOfNode(node.childForFieldName("name"));
                if (declaredName) {
                    functions.push(declaredName);
                }
                else if (node.parent?.type === "variable_declarator") {
                    const lhs = extractIdentifierFromLhs(node.parent.childForFieldName("name"));
                    if (lhs)
                        functions.push(lhs);
                }
                break;
            }
            case "class_declaration":
            case "class": {
                const name = nameOfNode(node.childForFieldName("name"));
                if (name) {
                    classes.push(name);
                }
                else if (node.parent?.type === "variable_declarator") {
                    const lhs = extractIdentifierFromLhs(node.parent.childForFieldName("name"));
                    if (lhs)
                        classes.push(lhs);
                }
                break;
            }
            case "import_statement": {
                const source = node.childForFieldName("source");
                if (source)
                    imports.push(source.text.replace(/^['"]|['"]$/g, ""));
                break;
            }
            case "call_expression": {
                const fn = node.childForFieldName("function");
                if (fn?.type === "identifier" && fn.text === "require") {
                    const args = node.childForFieldName("arguments");
                    const firstArg = args?.namedChild(0);
                    if (firstArg?.type === "string") {
                        imports.push(firstArg.text.replace(/^['"]|['"]$/g, ""));
                    }
                }
                break;
            }
        }
        for (const child of node.namedChildren) {
            visit(child);
        }
    }
    visit(tree.rootNode);
    return { functions, classes, imports };
}
function extractFile(filePath, projectPath) {
    const sourceCode = fs.readFileSync(filePath, "utf-8");
    const language = filePath.endsWith(".ts") ? TypeScript : TreeSitterJavaScript;
    const { functions, classes, imports } = extractFromSource(sourceCode, language);
    return {
        relativePath: path.relative(projectPath, filePath),
        functions,
        classes,
        imports,
    };
}
export function analyzeCodebase(projectPath) {
    const resolvedProjectPath = path.resolve(projectPath);
    const db = openDb(resolvedProjectPath);
    const insertFile = db.prepare("INSERT INTO files (file_path, file_name, indexed_at) VALUES (?, ?, ?) ON CONFLICT(file_path) DO UPDATE SET indexed_at = excluded.indexed_at RETURNING id");
    const deleteChildren = db.prepare("DELETE FROM functions WHERE file_id = ?");
    const deleteClasses = db.prepare("DELETE FROM classes WHERE file_id = ?");
    const deleteImports = db.prepare("DELETE FROM imports WHERE file_id = ?");
    const insertFunction = db.prepare("INSERT INTO functions (file_id, name) VALUES (?, ?)");
    const insertClass = db.prepare("INSERT INTO classes (file_id, name) VALUES (?, ?)");
    const insertImport = db.prepare("INSERT INTO imports (file_id, source) VALUES (?, ?)");
    const files = walkProjectFiles(resolvedProjectPath);
    let filesIndexed = 0;
    let totalFunctions = 0;
    let totalClasses = 0;
    const runAll = db.transaction((filePaths) => {
        for (const filePath of filePaths) {
            let extraction;
            try {
                extraction = extractFile(filePath, resolvedProjectPath);
            }
            catch {
                // Tree-sitter (or the file read) choked on this file — better-sqlite3
                // transactions roll back entirely on a throw, so skipping here
                // (rather than letting it propagate) is what keeps one bad file from
                // wiping out every other file already processed in this run.
                continue;
            }
            const row = insertFile.get(extraction.relativePath, path.basename(extraction.relativePath), new Date().toISOString());
            const fileId = row.id;
            deleteChildren.run(fileId);
            deleteClasses.run(fileId);
            deleteImports.run(fileId);
            for (const name of extraction.functions) {
                insertFunction.run(fileId, name);
                totalFunctions++;
            }
            for (const name of extraction.classes) {
                insertClass.run(fileId, name);
                totalClasses++;
            }
            for (const source of extraction.imports) {
                insertImport.run(fileId, source);
            }
            filesIndexed++;
        }
    });
    runAll(files);
    db.close();
    return {
        files_indexed: filesIndexed,
        functions: totalFunctions,
        classes: totalClasses,
    };
}
function findFileRow(db, fileName) {
    const exact = db
        .prepare("SELECT id, file_path, file_name FROM files WHERE file_path = ?")
        .get(fileName);
    if (exact)
        return exact;
    return db
        .prepare("SELECT id, file_path, file_name FROM files WHERE file_name = ?")
        .get(path.basename(fileName));
}
export function getFileSummary(projectPath, fileName) {
    const resolvedProjectPath = path.resolve(projectPath);
    const dbPath = getDbPath(resolvedProjectPath);
    if (!fs.existsSync(dbPath)) {
        throw new Error(`No AST index found at ${dbPath}. Run analyze_codebase on this project first.`);
    }
    const db = new Database(dbPath, { readonly: true });
    try {
        const fileRow = findFileRow(db, fileName);
        if (!fileRow) {
            throw new Error(`File "${fileName}" not found in the AST index for ${resolvedProjectPath}.`);
        }
        const functions = db.prepare("SELECT name FROM functions WHERE file_id = ?").all(fileRow.id).map((r) => r.name);
        const classes = db.prepare("SELECT name FROM classes WHERE file_id = ?").all(fileRow.id).map((r) => r.name);
        return { file_path: fileRow.file_path, functions, classes };
    }
    finally {
        db.close();
    }
}
export function findDependencies(projectPath, fileName) {
    const resolvedProjectPath = path.resolve(projectPath);
    const dbPath = getDbPath(resolvedProjectPath);
    if (!fs.existsSync(dbPath)) {
        throw new Error(`No AST index found at ${dbPath}. Run analyze_codebase on this project first.`);
    }
    const db = new Database(dbPath, { readonly: true });
    try {
        const fileRow = findFileRow(db, fileName);
        if (!fileRow) {
            throw new Error(`File "${fileName}" not found in the AST index for ${resolvedProjectPath}.`);
        }
        const imports = db.prepare("SELECT source FROM imports WHERE file_id = ?").all(fileRow.id).map((r) => r.source);
        return { file_path: fileRow.file_path, imports };
    }
    finally {
        db.close();
    }
}
