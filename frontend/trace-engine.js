(function (root) {
  'use strict';

  /*
   * CodeFlowTraceEngine deliberately does not execute source text.  It parses a
   * small, documented teaching subset into statements and evaluates expressions
   * with the parser below.  Unsupported non-empty source is handled by a
   * syntax-only generic story, so this file remains a plain browser script
   * while keeping pasted code data rather than executable code.
   */

  var MAX_SOURCE_LENGTH = 30000;
  var MAX_LINES = 300;
  var MAX_TRACE_STEPS = 5000;
  var MAX_ARRAY_LENGTH = 1000;

  function TraceError(message) {
    this.name = 'TraceError';
    this.message = message;
  }
  TraceError.prototype = Object.create(Error.prototype);
  TraceError.prototype.constructor = TraceError;

  function fail(message) { throw new TraceError(message); }

  function own(object, key) { return Object.prototype.hasOwnProperty.call(object, key); }

  function clone(value) {
    if (Array.isArray(value)) return value.map(clone);
    if (value && typeof value === 'object') {
      var copy = Object.create(null);
      Object.keys(value).forEach(function (key) { copy[key] = clone(value[key]); });
      return copy;
    }
    return value;
  }

  function equal(a, b) {
    if (Array.isArray(a) || Array.isArray(b)) {
      if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
      for (var i = 0; i < a.length; i += 1) if (!equal(a[i], b[i])) return false;
      return true;
    }
    return a === b || (a !== a && b !== b);
  }

  function display(value) {
    if (value === undefined) return 'empty';
    if (value === null) return 'null';
    if (typeof value === 'string') return '"' + value + '"';
    if (typeof value === 'boolean') return value ? 'true' : 'false';
    if (Array.isArray(value)) return '[' + Array.prototype.map.call(value, function (item) { return display(item); }).join(', ') + ']';
    return String(value);
  }

  function displayState(env) {
    var state = Object.create(null);
    Object.keys(env).forEach(function (key) { state[key] = display(env[key]); });
    return state;
  }

  function normalLanguage(language) {
    var name = String(language || 'Python').trim().toLowerCase();
    if (name === 'python' || name === 'py') return 'python';
    if (name === 'c') return 'c';
    if (name === 'c++' || name === 'cpp' || name === 'cplusplus') return 'cpp';
    fail('This demo supports Python, C, and C++ only. Choose one of those languages.');
  }

  function stripPythonComment(text) {
    var quote = null;
    for (var i = 0; i < text.length; i += 1) {
      var ch = text[i];
      if (quote) {
        if (ch === '\\') i += 1;
        else if (ch === quote) quote = null;
      } else if (ch === '"' || ch === "'") quote = ch;
      else if (ch === '#') return text.slice(0, i);
    }
    return text;
  }

  function stripCComments(source) {
    var out = '';
    var quote = null;
    var block = false;
    for (var i = 0; i < source.length; i += 1) {
      var ch = source[i];
      var next = source[i + 1];
      if (block) {
        if (ch === '*' && next === '/') { block = false; i += 1; out += '  '; }
        else if (ch === '\n') out += '\n';
        else out += ' ';
      } else if (quote) {
        out += ch;
        if (ch === '\\' && i + 1 < source.length) { out += source[i + 1]; i += 1; }
        else if (ch === quote) quote = null;
      } else if ((ch === '"' || ch === "'")) { quote = ch; out += ch; }
      else if (ch === '/' && next === '*') { block = true; i += 1; out += '  '; }
      else if (ch === '/' && next === '/') {
        while (i < source.length && source[i] !== '\n') { out += ' '; i += 1; }
        if (i < source.length) out += '\n';
      } else out += ch;
    }
    if (block) fail('A block comment was not closed. Finish the comment or remove it.');
    return out;
  }

  function splitTopLevel(text, separator) {
    var parts = [];
    var start = 0;
    var parens = 0;
    var brackets = 0;
    var braces = 0;
    var quote = null;
    for (var i = 0; i < text.length; i += 1) {
      var ch = text[i];
      if (quote) {
        if (ch === '\\') i += 1;
        else if (ch === quote) quote = null;
        continue;
      }
      if (ch === '"' || ch === "'") quote = ch;
      else if (ch === '(') parens += 1;
      else if (ch === ')') parens -= 1;
      else if (ch === '[') brackets += 1;
      else if (ch === ']') brackets -= 1;
      else if (ch === '{') braces += 1;
      else if (ch === '}') braces -= 1;
      else if (ch === separator && parens === 0 && brackets === 0 && braces === 0) {
        parts.push(text.slice(start, i).trim());
        start = i + 1;
      }
    }
    if (quote || parens !== 0 || brackets !== 0 || braces !== 0) fail('This line has unbalanced quotes or brackets.');
    parts.push(text.slice(start).trim());
    return parts;
  }

  function pythonRecords(source) {
    var raw = source.split(/\r?\n/);
    if (raw.length > MAX_LINES) fail('Please keep a trace to 300 lines or fewer.');
    var records = [];
    raw.forEach(function (line, index) {
      var without = stripPythonComment(line);
      if (/\t/.test(without)) fail('Use spaces for Python indentation so the trace is unambiguous.');
      var text = without.trim();
      if (!text) return;
      var indent = without.length - without.replace(/^\s+/, '').length;
      records.push({ line: index + 1, indent: indent, text: text });
    });
    return records;
  }

  function parsePython(source) {
    var records = pythonRecords(source);
    var cursor = 0;
    function block(indent) {
      var nodes = [];
      while (cursor < records.length) {
        var record = records[cursor];
        if (record.indent < indent) break;
        if (record.indent > indent) fail('Line ' + record.line + ' has unexpected indentation.');
        cursor += 1;
        var text = record.text;
        if (/^(?:for\b|if\b)/.test(text)) {
          var isFor = /^for\b/.test(text);
          if (!(isFor ? /:$/.test(text) : /:$/.test(text))) fail('Line ' + record.line + ' needs a block ending with a colon.');
          var header = text.slice(0, -1).trim();
          var next = records[cursor];
          if (!next || next.indent <= indent) fail('Line ' + record.line + ' needs an indented body.');
           var node = { type: isFor ? 'for' : 'if', line: record.line, header: header, children: [], elseChildren: null };
           node.children = block(next.indent);
           nodes.push(node);
         } else if (/^(?:else|elif)\b/.test(text)) {
           if (!/^else\s*:$/.test(text) || !nodes.length || nodes[nodes.length - 1].type !== 'if' || nodes[nodes.length - 1].elseChildren) fail('Line ' + record.line + ' uses an unsupported else/elif structure.');
           var previous = nodes[nodes.length - 1];
           var elseNext = records[cursor];
           if (!elseNext || elseNext.indent <= indent) fail('Line ' + record.line + ' needs an indented else body.');
           previous.elseChildren = block(elseNext.indent);
         } else {
          nodes.push({ type: 'stmt', line: record.line, text: text });
        }
      }
      return nodes;
    }
    var tree = block(records.length ? records[0].indent : 0);
    if (!tree.length) fail('Add a small supported program before creating a trace.');
    return tree;
  }

  function cTokens(source) {
    var cleaned = stripCComments(source);
    if (cleaned.split(/\r?\n/).length > MAX_LINES) fail('Please keep a trace to 300 lines or fewer.');
    var tokens = [];
    var current = '';
    var line = 1;
    var startLine = 1;
    var parens = 0;
    var brackets = 0;
    var initializerBraces = 0;
    var quote = null;
    function flush() {
      var value = current.trim();
      if (value) tokens.push({ kind: 'stmt', text: value, line: startLine });
      current = '';
    }
    for (var i = 0; i < cleaned.length; i += 1) {
      var ch = cleaned[i];
      if (ch === '\n') line += 1;
      if (quote) {
        current += ch;
        if (ch === '\\' && i + 1 < cleaned.length) { current += cleaned[i + 1]; i += 1; }
        else if (ch === quote) quote = null;
      } else if (ch === '"' || ch === "'") { quote = ch; current += ch; }
      else if (ch === '(') { parens += 1; current += ch; }
      else if (ch === ')') { parens -= 1; if (parens < 0) fail('Line ' + line + ' has an unmatched closing parenthesis.'); current += ch; }
      else if (ch === '[') { brackets += 1; current += ch; }
      else if (ch === ']') { brackets -= 1; if (brackets < 0) fail('Line ' + line + ' has an unmatched closing bracket.'); current += ch; }
      else if (ch === '{' && parens === 0 && brackets === 0) {
        /* C array initializers use braces too; only a control/function header opens a block. */
        var beforeBrace = current.trim();
        if (initializerBraces || /=\s*$/.test(beforeBrace)) { current += ch; initializerBraces += 1; }
        else { flush(); tokens.push({ kind: 'open', line: line }); startLine = line; }
      }
      else if (ch === '}' && parens === 0 && brackets === 0) {
        if (initializerBraces) { current += ch; initializerBraces -= 1; }
        else { flush(); tokens.push({ kind: 'close', line: line }); startLine = line; }
      }
      else if (ch === ';' && parens === 0 && brackets === 0) { flush(); startLine = line; }
      else {
        if (ch === '\n' && parens === 0 && brackets === 0 && /^#/.test(current.trim())) { flush(); startLine = line; }
        else if (!current && /\s/.test(ch)) { if (ch === '\n') startLine = line; }
        else current += ch;
      }
    }
    if (quote) fail('A string or character literal was not closed.');
    if (parens || brackets) fail('The program has unbalanced parentheses or brackets.');
    flush();
    return tokens;
  }

  function parseC(source) {
    var tokens = cTokens(source);
    var root = [];
    var containers = [{ children: root, wrapper: false }];
    var pending = null;
    var inMain = false;
    var mainSeen = false;
    tokens.forEach(function (token) {
      var current = containers[containers.length - 1].children;
      if (token.kind === 'stmt') {
        if (pending) fail('Line ' + token.line + ' follows a for/if header without braces. Control-flow blocks must use { and }.');
        if (/^#/.test(token.text.trim())) {
           if (!/^#\s*include\s+(?:<[^>\r\n]+>|"[^"\r\n]+")\s*$/.test(token.text.trim())) fail('Only #include directives are supported; preprocessors such as #define are not executed.');
           return;
         }
         if (/^using\s+namespace\s+std\s*$/.test(token.text.trim())) return;
         var text = token.text.trim();
         if (/^else\b/.test(text)) {
           if (mainSeen && !inMain) fail('C/C++ control flow after main is outside this safe subset.');
           if (!/^else\s*$/.test(text) || !current.length || current[current.length - 1].type !== 'if' || current[current.length - 1].elseChildren) fail('Line ' + token.line + ' uses an unsupported else structure.');
           pending = { type: 'else', line: token.line, target: current[current.length - 1] };
           return;
         }
         var match = /^(for|if)\s*/.exec(text);
         if (match) {
           if (mainSeen && !inMain) fail('C/C++ control flow after main is outside this safe subset.');
           var kind = match[1];
           if (kind === 'for' && !/\)\s*$/.test(text)) fail('Line ' + token.line + ' has an unsupported for-loop header.');
           pending = { type: kind, line: token.line, header: text, children: [], elseChildren: null };
         } else if (/^(?:(?:const|static|unsigned|signed|long|short)\s+)*(?:void|int|float|double|char|bool|auto|std::string|string)\s+[A-Za-z_]\w*\s*\([^;]*\)$/.test(text)) {
           if (!/^int\s+main\s*\(\s*(?:void)?\s*\)$/.test(text)) fail('Only one simple main function is supported; extra functions or main parameters are outside this safe subset.');
           if (mainSeen || inMain) fail('Only one main function is supported by the safe trace engine.');
           if (root.length) fail('Do not mix a top-level C/C++ snippet with a main function in this safe subset.');
           pending = { type: 'wrapper', line: token.line, header: text, children: [] };
         } else {
           if (mainSeen && !inMain) fail('C/C++ executable statements after main are outside this safe subset.');
           current.push({ type: 'stmt', line: token.line, text: text });
         }
       } else if (token.kind === 'open') {
         if (!pending) fail('Line ' + token.line + ' opens a block without a supported main, for, or if statement.');
         if (pending.type === 'wrapper') {
           if (mainSeen || inMain) fail('Only one main function is supported by the safe trace engine.');
           mainSeen = true;
           inMain = true;
           containers.push({ children: root, wrapper: true });
         } else if (pending.type === 'else') {
           pending.target.elseChildren = [];
           containers.push({ children: pending.target.elseChildren, wrapper: false });
         } else {
           current.push(pending);
           containers.push({ children: pending.children, wrapper: false });
        }
        pending = null;
      } else if (token.kind === 'close') {
         if (pending) fail('Line ' + token.line + ' has an incomplete block header.');
         if (containers.length === 1) fail('Line ' + token.line + ' closes a block that was not opened.');
         var closed = containers.pop();
         if (closed.wrapper) inMain = false;
       }
     });
    if (pending) fail('The final block header needs braces.');
    if (containers.length !== 1) fail('A block was opened but never closed.');
    if (inMain) fail('The main function block was not closed.');
    if (!root.length) fail('Add a small supported program before creating a trace.');
    return root;
  }

  function expressionTokens(text) {
    var tokens = [];
    var i = 0;
    while (i < text.length) {
      var ch = text[i];
      if (/\s/.test(ch)) { i += 1; continue; }
      if (ch === '"' || ch === "'") {
        var quote = ch;
        var value = '';
        i += 1;
        var closed = false;
        while (i < text.length) {
          ch = text[i++];
          if (ch === '\\') {
            if (i >= text.length) fail('A string literal ends with an incomplete escape.');
            var escaped = text[i++];
            value += escaped === 'n' ? '\n' : escaped === 't' ? '\t' : escaped;
          } else if (ch === quote) { closed = true; break; }
          else value += ch;
        }
        if (!closed) fail('A string literal was not closed.');
        tokens.push({ type: 'value', value: value });
      } else if (/\d/.test(ch) || (ch === '.' && /\d/.test(text[i + 1] || ''))) {
        var number = text.slice(i).match(/^(?:\d+(?:\.\d*)?|\.\d+)/)[0];
        tokens.push({ type: 'value', value: Number(number), raw: number }); i += number.length;
      } else if (/[A-Za-z_]/.test(ch)) {
        var word = text.slice(i).match(/^[A-Za-z_]\w*/)[0];
        tokens.push({ type: 'word', value: word }); i += word.length;
      } else {
        var two = text.slice(i, i + 2);
        if (['==', '!=', '<=', '>=', '&&', '||', '+=', '-=', '*=', '/=', '%='].indexOf(two) >= 0) { tokens.push({ type: 'op', value: two }); i += 2; }
        else if ('()+-*/%[]<>,!'.indexOf(ch) >= 0) { tokens.push({ type: 'op', value: ch }); i += 1; }
        else fail('The expression uses an unsupported character near "' + text.slice(i, i + 12) + '".');
      }
    }
    return tokens;
  }

  function evaluate(text, env) {
    var source = text.trim();
    if (source[0] === '{' && source[source.length - 1] === '}') source = '[' + source.slice(1, -1) + ']';
    var tokens = expressionTokens(source);
    var position = 0;
    function peek(value) { return tokens[position] && (value === undefined || tokens[position].value === value); }
    function take(value) {
      if (!peek(value)) fail('Expected "' + value + '" in the expression.');
      return tokens[position++];
    }
    function primary() {
      var token = tokens[position++];
      if (!token) fail('An expression is missing a value.');
      var value;
      if (token.type === 'value') value = token.value;
      else if (token.type === 'word') {
        if (token.value === 'true' || token.value === 'True') value = true;
        else if (token.value === 'false' || token.value === 'False') value = false;
        else if (token.value === 'null' || token.value === 'None' || token.value === 'NULL') value = null;
        else if (token.value === 'len') {
          take('('); var argument = expression(); take(')');
          if (!(typeof argument === 'string' || Array.isArray(argument))) fail('len() only works with an array or string in this demo.');
          value = argument.length;
        } else {
          if (!own(env, token.value)) fail('The variable "' + token.value + '" is used before it is assigned.');
          value = env[token.value];
          if (value === undefined) fail('The variable "' + token.value + '" is uninitialized. Assign it before reading it.');
        }
      } else if (token.value === '(') { value = expression(); take(')'); }
      else if (token.value === '[') {
        value = [];
        if (!peek(']')) {
          do { value.push(expression()); } while (peek(',') && (position += 1));
        }
        take(']');
        if (value.length > MAX_ARRAY_LENGTH) fail('Arrays are limited to ' + MAX_ARRAY_LENGTH + ' values in a trace.');
      } else fail('Expected a number, string, array, or variable.');
      while (peek('[')) {
        take('['); var index = expression(); take(']');
        if (!Array.isArray(value) && typeof value !== 'string') fail('Only arrays and strings can be indexed.');
        if (!Number.isInteger(index)) fail('Array indexes must be whole numbers.');
        if (index < 0) fail('Negative array indexes are not supported by this browser-safe trace subset.');
        if (index >= value.length) fail('The array index ' + index + ' is outside the available values.');
        value = value[index];
        if (value === undefined) fail('The selected array element is uninitialized. Assign it before reading it.');
      }
      return value;
    }
    function unary() {
      if (peek('-')) { position += 1; var negative = unary(); if (typeof negative !== 'number') fail('Unary minus needs a number.'); return -negative; }
      if (peek('+')) { position += 1; return unary(); }
      if (peek('!') || peek('not')) { position += 1; return !unary(); }
      return primary();
    }
    function arithmetic(level, next) {
      var value = next();
      while (level.some(function (operator) { return peek(operator); })) {
        var op = tokens[position++].value;
        var right = next();
        if (op === '+' && (typeof value === 'string' || typeof right === 'string')) {
          value = String(value) + String(right);
        } else if (op === '+' && Array.isArray(value) && Array.isArray(right)) value = value.concat(right);
        else if (typeof value !== 'number' || typeof right !== 'number') fail('Arithmetic needs numbers (or two strings/arrays with +).');
        else if (op === '+') value += right;
        else if (op === '-') value -= right;
        else if (op === '*') value *= right;
        else if (op === '/') { if (right === 0) fail('Division by zero is not allowed in a trace.'); value /= right; }
        else if (op === '%') { if (right === 0) fail('Division by zero is not allowed in a trace.'); value %= right; }
        if (typeof value === 'number' && !Number.isFinite(value)) fail('Arithmetic produced a non-finite number.');
      }
      return value;
    }
    function multiplicative() { return arithmetic(['*', '/', '%'], unary); }
    function additive() { return arithmetic(['+', '-'], multiplicative); }
    function relational() {
      var value = additive();
      while (peek('<') || peek('>') || peek('<=') || peek('>=') || peek('in') || (peek('not') && tokens[position + 1] && tokens[position + 1].value === 'in')) {
        var op = tokens[position++].value;
        if (op === 'not') { take('in'); op = 'not in'; }
        var right = additive();
        if (op === 'in' || op === 'not in') {
          var found = Array.isArray(right) || typeof right === 'string' ? right.indexOf(value) >= 0 : false;
          value = op === 'in' ? found : !found;
        } else if (op === '<') value = value < right;
        else if (op === '>') value = value > right;
        else if (op === '<=') value = value <= right;
        else value = value >= right;
      }
      return value;
    }
    function equality() {
      var value = relational();
      while (peek('==') || peek('!=')) { var op = tokens[position++].value; var right = relational(); value = op === '==' ? equal(value, right) : !equal(value, right); }
      return value;
    }
    function andExpression() { var value = equality(); while (peek('and') || peek('&&')) { position += 1; var right = equality(); value = Boolean(value && right); } return value; }
    function expression() { var value = andExpression(); while (peek('or') || peek('||')) { position += 1; var right = andExpression(); value = Boolean(value || right); } return value; }
    var result = expression();
    if (position !== tokens.length) fail('The expression has an unsupported or unexpected part near "' + tokens[position].value + '".');
    return result;
  }

  function evaluateForLanguage(text, env, language) {
    var result = evaluate(text, env);
    if (language !== 'python' && typeof result === 'number' && !Number.isInteger(result) && hasIntegerDivision(text, env)) {
      fail('Fractional C/C++ division is outside this safe subset; use a decimal operand or a whole-number expression.');
    }
    return result;
  }

  function hasIntegerDivision(text, env) {
    var tokens = expressionTokens(text);
    function isFractionalOperand(token) {
      if (!token) return false;
      if (token.type === 'value' && typeof token.value === 'number') return token.raw && token.raw.indexOf('.') >= 0;
      if (token.type === 'word' && own(env, token.value) && typeof env[token.value] === 'number') return !Number.isInteger(env[token.value]);
      return false;
    }
    return tokens.some(function (token, index) {
      return token.type === 'op' && token.value === '/' && !isFractionalOperand(tokens[index - 1]) && !isFractionalOperand(tokens[index + 1]);
    });
  }

  function findAssignment(text) {
    var parens = 0; var brackets = 0; var quote = null;
    for (var i = 0; i < text.length; i += 1) {
      var ch = text[i];
      if (quote) { if (ch === '\\') i += 1; else if (ch === quote) quote = null; continue; }
      if (ch === '"' || ch === "'") quote = ch;
      else if (ch === '(') parens += 1;
      else if (ch === ')') parens -= 1;
      else if (ch === '[') brackets += 1;
      else if (ch === ']') brackets -= 1;
      else if (parens === 0 && brackets === 0 && (ch === '=' || (/[+\-*/%]/.test(ch) && text[i + 1] === '='))) {
        var previous = text[i - 1] || '';
        var next = text[i + 1] || '';
        if (ch === '=' && (previous === '=' || previous === '!' || previous === '<' || previous === '>')) continue;
        if (ch === '=' && next === '=') continue;
        var op = ch === '=' ? '=' : ch + '=';
        return { index: i, op: op };
      }
    }
    return null;
  }

  /*
   * Keep the learner-facing calculation text inside the same bounded parser
   * used for execution.  This is deliberately a presentation helper rather
   * than a second evaluator: an expression that cannot be rendered without
   * making a guess simply has no evaluatedExpression metadata.
   */
  function substitutedExpression(text, env) {
    try {
      var tokens = expressionTokens(text);
      var parts = [];
      function tokenSource(token) { return token.type === 'value' ? display(token.value) : token.value; }
      for (var i = 0; i < tokens.length; i += 1) {
        var token = tokens[i];
        if (token.type === 'value') { parts.push(display(token.value)); continue; }
        if (token.type !== 'word') { parts.push(token.value); continue; }
        if (token.value === 'true' || token.value === 'True') { parts.push('true'); continue; }
        if (token.value === 'false' || token.value === 'False') { parts.push('false'); continue; }
        if (token.value === 'null' || token.value === 'None' || token.value === 'NULL') { parts.push('null'); continue; }
        if (token.value === 'len' || token.value === 'in' || token.value === 'not' || token.value === 'and' || token.value === 'or') { parts.push(token.value); continue; }
        if (!own(env, token.value) || env[token.value] === undefined) return null;
        if ((Array.isArray(env[token.value]) || typeof env[token.value] === 'string') && tokens[i + 1] && tokens[i + 1].value === '[') {
          var depth = 1;
          var end = i + 2;
          while (end < tokens.length && depth) {
            if (tokens[end].value === '[') depth += 1;
            else if (tokens[end].value === ']') depth -= 1;
            end += 1;
          }
          if (depth) return null;
          var indexText = tokens.slice(i + 2, end - 1).map(tokenSource).join(' ');
          var index = evaluate(indexText, env);
          if (!Number.isInteger(index) || index < 0 || index >= env[token.value].length) return null;
          if (env[token.value][index] === undefined) return null;
          parts.push(display(env[token.value][index]));
          i = end - 1;
        } else if (Array.isArray(env[token.value])) {
          parts.push(token.value);
        } else {
          parts.push(display(env[token.value]));
        }
      }
      return parts.join(' ');
    } catch (_) {
      return null;
    }
  }

  function evaluatedExpression(text, env, value) {
    var rendered = substitutedExpression(text, env);
    return rendered === null ? null : rendered + ' = ' + display(value);
  }

  var declarationPattern = /^(?:(?:const|static)\s+)?(?:(?:unsigned|signed|long|short)\s+)*(?:int|float|double|char|bool|size_t|auto|string|std::string)(?:\s*\*)?\s+(.+)$/;
  function stripDeclaration(text, language) {
    if (language === 'python') return { text: text, declared: false, type: null };
    if (/^(?:(?:const|static)\s+)?(?:(?:unsigned|signed|long|short)\s+)*(?:int|float|double|char|bool|size_t|auto|string|std::string)\s*\*/.test(text)) fail('Pointer declarations are not supported by the safe trace engine.');
    var match = declarationPattern.exec(text);
    if (!match) return { text: text, declared: false, type: null };
    var typeMatch = text.match(/(?:int|float|double|char|bool|size_t|auto|string|std::string)\s+/);
    var type = typeMatch ? typeMatch[0].trim() : 'number';
    var rest = match[1].trim();
    if (type === 'char') rest = rest.replace(/^\*\s*/, '');
    return { text: rest, declared: true, type: type };
  }

  function defaultValue(type, arrayLength) {
    if (arrayLength !== null) {
      if (!Number.isInteger(arrayLength) || arrayLength <= 0 || arrayLength > MAX_ARRAY_LENGTH) fail('C arrays must have a positive bound of at most ' + MAX_ARRAY_LENGTH + '.');
      var result = []; for (var i = 0; i < arrayLength; i += 1) result.push(undefined);
      return result;
    }
    fail('Uninitialized C scalar variables are not traced safely. Initialize "' + (type || 'the variable') + '" before using it.');
  }

  function isIntegerType(type) {
    return ['int', 'long', 'short', 'unsigned', 'signed', 'size_t', 'bool', 'char'].indexOf(type) >= 0;
  }

  function validateValue(value, name) {
    if (typeof value === 'number' && !Number.isFinite(value)) fail('Arithmetic for "' + name + '" produced a non-finite number.');
    if (Array.isArray(value)) {
      if (value.length > MAX_ARRAY_LENGTH) fail('Arrays are limited to ' + MAX_ARRAY_LENGTH + ' values in a trace.');
      value.forEach(function (item) { validateValue(item, name); });
    }
  }

  function validateAssignedType(value, type, name) {
    if (!type || (type && type.kind === 'array')) return;
    if (type === 'auto') return;
    if (isIntegerType(type)) {
      if (type === 'char' && typeof value === 'string') {
        if (value.length !== 1) fail('C char variable "' + name + '" needs one character; wider strings are not supported.');
        return;
      }
      if (type === 'bool' && typeof value === 'boolean') return;
      if (typeof value !== 'number' || !Number.isInteger(value)) {
        fail('C integer variable "' + name + '" needs a whole-number value. Fractional integer division is not simulated.');
      }
      return;
    }
    if (type === 'float' || type === 'double') {
      if (typeof value !== 'number') fail('C numeric variable "' + name + '" needs a number.');
      return;
    }
    if (type === 'string' || type === 'std::string') {
      if (typeof value !== 'string') fail('String variable "' + name + '" needs a string value.');
    }
  }

  function parseTarget(text, env, forWrite) {
    var simple = /^([A-Za-z_]\w*)$/.exec(text.trim());
    if (simple) return { name: simple[1], index: null };
    var indexed = /^([A-Za-z_]\w*)\s*\[(.+)\]$/.exec(text.trim());
    if (!indexed) fail('"' + text + '" is not a supported variable or array target.');
    var index = evaluate(indexed[2], env);
    if (!Number.isInteger(index)) fail('Array indexes must be whole numbers.');
    if (!own(env, indexed[1]) || (!Array.isArray(env[indexed[1]]) && typeof env[indexed[1]] !== 'string')) fail('The target array "' + indexed[1] + '" is not available.');
    if (index < 0) fail('Negative array indexes are not supported by this browser-safe trace subset.');
    if (forWrite && typeof env[indexed[1]] === 'string') fail('String element assignments are outside this safe trace subset.');
    if (forWrite && index >= env[indexed[1]].length) fail('The array index ' + index + ' is outside the available values.');
    return { name: indexed[1], index: index };
  }

  function assignmentInfo(text, language) {
    var declaration = stripDeclaration(text, language);
    var statement = declaration.text.trim();
    var increment = /^((?:[A-Za-z_]\w*)|(?:[A-Za-z_]\w*\s*\[[^\]]+\]))\s*(\+\+|--)$/.exec(statement) || /^(\+\+|--)([A-Za-z_]\w*)$/.exec(statement);
    if (increment) {
      if (language === 'python') fail('Python does not use ++ or --; use += or -= in the supported subset.');
      var targetText = increment[1] === '++' || increment[1] === '--' ? increment[2] : increment[1];
      return { declaration: declaration, target: targetText, op: increment[1] === '++' || increment[1] === '--' ? increment[1] : increment[2], expression: '1' };
    }
    var found = findAssignment(statement);
    if (found) return { declaration: declaration, target: statement.slice(0, found.index).trim(), op: found.op, expression: statement.slice(found.index + found.op.length).trim() };
    if (declaration.declared) return { declaration: declaration, target: statement, op: null, expression: null };
    return null;
  }

  function applyAssignment(text, language, env, types) {
    var info = assignmentInfo(text, language);
    if (!info) return null;
    var declarationArray = info.declaration.declared && /^(?:[A-Za-z_]\w*)\s*\[\s*(\d*)\s*\]$/.exec(info.target);
    var target = declarationArray ? { name: info.target.match(/^([A-Za-z_]\w*)/)[1], index: null } : parseTarget(info.target, env, info.expression !== null);
    if (language !== 'python' && !info.declaration.declared && !own(types, target.name)) fail('C/C++ assignments need a prior declaration for "' + target.name + '".');
    var expressionEnv = clone(env);
    var before = target.index === null ? clone(env[target.name]) : clone(env[target.name][target.index]);
    var calculationExpression = info.expression;
    if (info.expression === null) {
      if (!declarationArray) fail('Uninitialized C scalar variables are not traced safely. Initialize "' + target.name + '" before using it.');
      var declarationTarget = /^(\w+)\s*\[(\d+)\]$/.exec(info.target);
      var arrayLength = declarationTarget ? Number(declarationTarget[2]) : null;
      if (arrayLength === null) fail('Uninitialized C arrays need an explicit positive bound, for example int values[3].');
      env[target.name] = defaultValue(info.declaration.type, arrayLength);
      types[target.name] = { kind: 'array', elementType: info.declaration.type };
    } else {
      var value = evaluateForLanguage(info.expression, env, language);
      if (declarationArray) {
        if (info.declaration.type === 'char' && typeof value === 'string') {
          env[target.name] = value;
          types[target.name] = { kind: 'string', elementType: 'char' };
          validateValue(value, target.name);
          return { target: target.name, before: before, after: value, expression: info.expression, evaluatedExpression: evaluatedExpression(calculationExpression, expressionEnv, value) };
        }
        if (!Array.isArray(value)) fail('An array declaration needs an array initializer.');
        var requestedLength = declarationArray[1] ? Number(declarationArray[1]) : null;
        if (requestedLength !== null && requestedLength !== value.length) fail('The array initializer length does not match its declared size.');
        if (value.length > MAX_ARRAY_LENGTH) fail('Arrays are limited to ' + MAX_ARRAY_LENGTH + ' values in a trace.');
        if (isIntegerType(info.declaration.type) && value.some(function (item) { return typeof item !== 'number' || !Number.isInteger(item); })) fail('C integer arrays cannot be initialized with fractional values.');
        env[target.name] = clone(value);
        types[target.name] = { kind: 'array', elementType: info.declaration.type };
        validateValue(value, target.name);
        var declaredAfter = clone(env[target.name]);
        return { target: target.name, before: before, after: declaredAfter, expression: info.expression, evaluatedExpression: evaluatedExpression(calculationExpression, expressionEnv, declaredAfter) };
      }
      var targetType = info.declaration.declared ? info.declaration.type : types[target.name];
      if (target.index !== null && targetType && targetType.kind === 'array') targetType = targetType.elementType;
      if (info.op !== '=') {
        var arithmeticOp = info.op[0];
        if (typeof before !== 'number' || typeof value !== 'number') fail('Compound arithmetic assignments need numbers.');
        if ((arithmeticOp === '/' || arithmeticOp === '%') && value === 0) fail('Division by zero is not allowed in a compound assignment.');
        calculationExpression = display(before) + ' ' + arithmeticOp + ' ' + info.expression;
        value = arithmeticOp === '+' ? before + value : arithmeticOp === '-' ? before - value : arithmeticOp === '*' ? before * value : arithmeticOp === '/' ? before / value : before % value;
      }
      if (language !== 'python') validateAssignedType(value, targetType, target.name);
      validateValue(value, target.name);
      if (target.index === null) env[target.name] = clone(value);
      else env[target.name][target.index] = clone(value);
      if (info.declaration.declared) types[target.name] = info.declaration.type;
    }
    var after = target.index === null ? clone(env[target.name]) : clone(env[target.name][target.index]);
    return {
      target: target.index === null ? target.name : target.name + '[' + target.index + ']',
      before: before,
      after: after,
      expression: info.expression,
      evaluatedExpression: calculationExpression === null ? null : evaluatedExpression(calculationExpression, expressionEnv, after)
    };
  }

  function parseOutput(text, env, language) {
    var printMatch = /^(?:print|puts)\s*\((.*)\)$/.exec(text);
    if (printMatch) {
      var values = splitTopLevel(printMatch[1], ',').filter(function (part) { return part !== ''; }).map(function (part) { return evaluateForLanguage(part, env, language); });
      return { value: values.map(function (item) { return typeof item === 'string' ? item : display(item); }).join(' '), expression: text };
    }
    var printfMatch = /^printf\s*\((.*)\)$/.exec(text);
    if (printfMatch) {
      var args = splitTopLevel(printfMatch[1], ',');
      if (!args.length) fail('printf needs a format string.');
      var format = evaluateForLanguage(args.shift(), env, language);
      if (typeof format !== 'string') fail('printf needs a string format.');
      var valuesForFormat = args.map(function (part) { return evaluateForLanguage(part, env, language); });
      var index = 0;
      var output = format.replace(/%[dfs]/g, function (marker) { var item = valuesForFormat[index++]; return item === undefined ? marker : String(item); });
      return { value: output, expression: text };
    }
    var cout = text.replace(/^std::cout\s*/, 'cout ');
    if (/^cout\s*<</.test(cout)) {
      var pieces = cout.replace(/^cout\s*<</, '').split('<<');
      var output = pieces.filter(function (part) { return part.trim() !== 'endl' && part.trim() !== 'std::endl'; }).map(function (part) { var item = evaluateForLanguage(part.trim(), env, language); return typeof item === 'string' ? item : display(item); }).join('');
      return { value: output, expression: text };
    }
    return null;
  }

  function compareValues(before, after) {
    if (equal(before, after)) return 'No variable values changed.';
    return before === undefined ? 'value: empty → ' + display(after) : display(before) + ' → ' + display(after);
  }

  function makeStep(ctx, node, title, what, changed, why, next, metadata) {
    if (ctx.steps.length >= MAX_TRACE_STEPS) fail('The trace reached its global limit of ' + MAX_TRACE_STEPS + ' steps and stopped safely.');
    var meta = metadata || {};
    var eventType = meta.eventType || 'statement';
    var step = {
      line: node.line,
      title: title,
      what: what,
      changed: changed,
      why: why,
      next: next,
      caption: what + ' ' + changed,
      vars: displayState(ctx.env),
      state: clone(ctx.env),
      output: ctx.output.slice(),
      event: meta.event || 'statement',
      eventType: eventType,
      loopId: meta.loopId == null ? null : meta.loopId,
      round: meta.round == null ? null : meta.round,
      counterName: meta.counterName == null ? null : meta.counterName,
      counterBefore: meta.counterBefore === undefined ? null : clone(meta.counterBefore),
      counterAfter: meta.counterAfter === undefined ? null : clone(meta.counterAfter),
      conditionText: meta.conditionText == null ? null : String(meta.conditionText),
      conditionResult: meta.conditionResult == null ? null : Boolean(meta.conditionResult),
      conditionValues: meta.conditionValues == null ? null : clone(meta.conditionValues),
      bodyLine: meta.bodyLine == null ? null : meta.bodyLine,
      condition: meta.condition || null,
      nextLine: meta.nextLine === undefined ? (ctx.nextLine == null ? null : ctx.nextLine) : meta.nextLine,
      totalRounds: meta.totalRounds == null ? null : meta.totalRounds,
      completedRounds: meta.completedRounds == null ? null : meta.completedRounds,
      loopLanguage: meta.loopLanguage == null ? null : String(meta.loopLanguage),
      incrementExpression: meta.incrementExpression == null ? null : String(meta.incrementExpression),
      target: meta.target == null ? null : String(meta.target),
      before: meta.before === undefined ? null : clone(meta.before),
      after: meta.after === undefined ? null : clone(meta.after),
      expression: meta.expression == null ? null : String(meta.expression),
      evaluatedExpression: meta.evaluatedExpression == null ? null : String(meta.evaluatedExpression),
      rangeExhausted: meta.rangeExhausted === true,
      stoppedByBreak: meta.stoppedByBreak === true,
      teacher: meta.teacher || what
    };
    step._explicitNextLine = meta.nextLine === undefined ? null : meta.nextLine;
    ctx.steps.push(step);
    return step;
  }

  function conditionExplanation(details) {
    if (!details) return 'The condition evaluated to a boolean result.';
    return 'Condition ' + display(details.left) + ' ' + details.operator + ' ' + display(details.right) + ' evaluated ' + (details.result ? 'true' : 'false') + '.';
  }

  function evaluateCondition(text, env, language) {
    var result = Boolean(evaluateForLanguage(text, env, language));
    var details = null;
    if (!/\b(?:and|or)\b|&&|\|\|/.test(text)) {
      var match = /^(.+?)\s*(not in|in|==|!=|<=|>=|<|>)\s*(.+)$/.exec(text.trim());
      if (match) {
         details = { left: evaluateForLanguage(match[1], env, language), operator: match[2], right: evaluateForLanguage(match[3], env, language), result: result };
       } else {
         details = { left: evaluateForLanguage(text, env, language), operator: 'is', right: true, result: result };
      }
    }
    return { result: result, details: details };
  }

  function nextLineText(codeLines, line) {
    if (line == null) return 'The trace is complete.';
    var source = codeLines[line - 1] == null ? '' : codeLines[line - 1].trim();
    return 'Next, line ' + line + (source ? ': ' + source : ' runs.');
  }

  function finalizeSteps(ctx) {
    ctx.steps.forEach(function (step, index) {
      var following = ctx.steps[index + 1];
      /* A trace is the execution order.  Static tree look-ahead is wrong for
       * a false branch because its first body line was never visited. */
      step.nextLine = following ? following.line : null;
      if (step.event === 'break' && step._explicitNextLine != null) step.nextLine = step._explicitNextLine;
      delete step._explicitNextLine;
      step.next = nextLineText(ctx.codeLines, step.nextLine);
    });
  }

  function executeStatement(node, ctx, language, activeLoop) {
    var text = node.text.trim();
    if (text === 'break') {
      if (!activeLoop) fail('Line ' + node.line + ' uses break outside a loop.');
      var breakMetadata = bodyMetadata(activeLoop, ctx, node.line);
      breakMetadata.event = 'break';
      breakMetadata.nextLine = activeLoop ? activeLoop.afterLoopLine : ctx.afterLoopLine;
      breakMetadata.teacher = activeLoop ? 'This body line says break, so the loop stops immediately.' : 'This line says break, so execution stops this loop.';
      makeStep(ctx, node, 'The loop stops here.', 'This line leaves the current loop immediately.', 'The loop changes from running to stopped.', 'The program already has the result it needs.', 'The simulator moves to the first line after the loop.', breakMetadata);
      return 'break';
    }
    if (/^return\s+0$/.test(text)) {
      if (language === 'python') fail('Python return statements are outside this trace subset.');
      return 'return';
    }
    if (/^(?:continue|return)\b/.test(text)) fail('Line ' + node.line + ' uses control flow outside this simple demo subset.');
    var output = parseOutput(text, ctx.env, language);
    if (output) {
      ctx.output.push(output.value);
      var outputMetadata = bodyMetadata(activeLoop, ctx, node.line);
      outputMetadata.nextLine = ctx.nextLine;
      outputMetadata.teacher = activeLoop ? 'This body line shows the result for round ' + activeLoop.round + '.' : 'This line shows a result to the learner.';
      makeStep(ctx, node, 'The program shows an output.', 'This line sends a value to the output.', 'output: empty → ' + output.value, 'Output makes the program result visible to the learner.', 'The simulator follows the next supported line.', outputMetadata);
      return null;
    }
    if (/^(?:print|puts|printf|std::cout|cout)\b/.test(text)) fail('Line ' + node.line + ' has an unsupported output form.');
    var result = applyAssignment(text, language, ctx.env, ctx.types);
    if (!result) fail('Line ' + node.line + ' is not supported. Use an assignment, loop, if, break, or common output statement.');
    var assignmentMetadata = bodyMetadata(activeLoop, ctx, node.line);
    assignmentMetadata.nextLine = ctx.nextLine;
    assignmentMetadata.target = result.target;
    assignmentMetadata.before = result.before;
    assignmentMetadata.after = result.after;
    assignmentMetadata.expression = result.expression;
    assignmentMetadata.evaluatedExpression = result.evaluatedExpression;
    var calculation = result.evaluatedExpression ? ' The safe calculation is ' + result.evaluatedExpression + '.' : '';
    assignmentMetadata.teacher = activeLoop ? 'This body line updates ' + result.target + ' during round ' + activeLoop.round + '.' + calculation : 'This line gives ' + result.target + ' a value for a later line.' + calculation;
    makeStep(ctx, node, 'The program updates ' + result.target + '.', 'This line assigns ' + result.target + '.' + calculation, result.target + ': ' + compareValues(result.before, result.after), 'Assignments give later lines a value to use.', 'The simulator follows the next supported line.', assignmentMetadata);
    return null;
  }

  function parseRange(header, env) {
    var match = /^for\s+([A-Za-z_]\w*)\s+in\s+range\s*\((.*)\)$/.exec(header);
    if (!match) fail('Only integer-bound Python loops such as for i in range(4) are supported.');
    var parts = splitTopLevel(match[2], ',').filter(function (part) { return part !== ''; });
    if (parts.length < 1 || parts.length > 3) fail('range() takes one to three integer bounds in this demo.');
    var values = parts.map(function (part) { return evaluateForLanguage(part, env, 'python'); });
    if (values.some(function (value) { return !Number.isInteger(value); })) fail('Python loop bounds must evaluate to whole numbers.');
    var start = values.length === 1 ? 0 : values[0];
    var stop = values.length === 1 ? values[0] : values[1];
    var step = values.length === 3 ? values[2] : 1;
    if (step === 0) fail('A range step cannot be zero.');
    return {
      variable: match[1],
      start: start,
      stop: stop,
      step: step,
      rangeExpression: 'range(' + parts.join(', ') + ')',
      incrementExpression: match[1] + ' += ' + display(step),
      conditionText: match[1] + ' ' + (step > 0 ? '<' : '>') + ' ' + display(stop)
    };
  }

  function parseCFor(header, env, language, types) {
    var match = /^for\s*\(([\s\S]*)\)$/.exec(header);
    if (!match) fail('Use a C/C++ for loop with initializer, integer condition, and increment.');
    var parts = splitTopLevel(match[1], ';');
    if (parts.length !== 3) fail('C/C++ for loops need exactly three parts: start; condition; increment.');
    var init = assignmentInfo(parts[0].trim(), language);
    if (!init || !init.target || init.expression === null) fail('The for-loop initializer must assign an integer variable.');
    var targetMatch = /^([A-Za-z_]\w*)$/.exec(init.target);
    if (!targetMatch) fail('The for-loop counter must be a simple variable.');
    if (!init.declaration.declared && !own(types, targetMatch[1])) fail('The C/C++ for-loop counter must be declared before it is used.');
    var existingCounterType = types[targetMatch[1]];
    if (!init.declaration.declared && existingCounterType && !isIntegerType(existingCounterType) && existingCounterType !== 'auto') fail('The C/C++ for-loop counter must use an integer type.');
    var initializerEnvironment = clone(env);
    var initialValue = evaluateForLanguage(init.expression, env, language);
    if (!Number.isInteger(initialValue)) fail('The for-loop counter must start at a whole number.');
    if (init.declaration.declared && !isIntegerType(init.declaration.type) && init.declaration.type !== 'auto') fail('The C/C++ for-loop counter must use an integer type.');
    validateAssignedType(initialValue, init.declaration.declared ? init.declaration.type : existingCounterType, targetMatch[1]);
    var initializerBefore = clone(env[targetMatch[1]]);
    env[targetMatch[1]] = initialValue;
    types[targetMatch[1]] = init.declaration.declared ? init.declaration.type : (existingCounterType || 'int');
    var condition = /^([A-Za-z_]\w*)\s*(<=|>=|<|>)\s*(.+)$/.exec(parts[1].trim());
    if (!condition || condition[1] !== targetMatch[1]) fail('The loop condition must compare its counter with an integer bound.');
    var escapedCounter = targetMatch[1].replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (new RegExp('\\b' + escapedCounter + '\\b').test(condition[3])) fail('The C/C++ loop bound cannot depend on the changing counter in this safe subset.');
    var bound = evaluateForLanguage(condition[3], env, language);
    if (!Number.isInteger(bound)) fail('The loop bound must evaluate to a whole number.');
    var increment = parts[2].trim();
    var incrementMatch = /^(?:([A-Za-z_]\w*)\s*(\+\+|--)|([A-Za-z_]\w*)\s*([+\-]=)\s*(\d+)|([+\-]{2})([A-Za-z_]\w*))$/.exec(increment);
    if (!incrementMatch || (incrementMatch[1] && incrementMatch[1] !== targetMatch[1]) || (incrementMatch[3] && incrementMatch[3] !== targetMatch[1]) || (incrementMatch[7] && incrementMatch[7] !== targetMatch[1])) fail('The loop increment must move its counter by a fixed integer step.');
    var step = 1;
    if (incrementMatch[2] === '--' || incrementMatch[4] === '-=' || incrementMatch[6] === '--') step = -1;
    if (incrementMatch[3]) step *= Number(incrementMatch[5] || 1);
    if (!step) fail('The for-loop increment cannot be zero.');
    if ((step > 0 && condition[2] !== '<' && condition[2] !== '<=') || (step < 0 && condition[2] !== '>' && condition[2] !== '>=')) fail('The for-loop condition and increment move in opposite directions.');
    return {
      variable: targetMatch[1],
      start: initialValue,
      stop: bound,
      step: step,
      operator: condition[2],
      conditionText: condition[0].trim(),
      incrementExpression: increment,
      initializerExpression: init.expression,
      initializerEvaluatedExpression: evaluatedExpression(init.expression, initializerEnvironment, initialValue),
      initializerBefore: initializerBefore,
      boundExpression: condition[3].trim()
    };
  }

  function conditionAllows(value, operator, bound) {
    if (operator === '<') return value < bound;
    if (operator === '<=') return value <= bound;
    if (operator === '>') return value > bound;
    return value >= bound;
  }

  function loopRoundCount(loop, operator) {
    var difference;
    if (loop.step > 0) {
      difference = loop.stop - loop.start;
      if (operator === '<') return difference > 0 ? Math.ceil(difference / loop.step) : 0;
      return difference >= 0 ? Math.floor(difference / loop.step) + 1 : 0;
    }
    difference = loop.start - loop.stop;
    if (operator === '>') return difference > 0 ? Math.ceil(difference / (-loop.step)) : 0;
    return difference >= 0 ? Math.floor(difference / (-loop.step)) + 1 : 0;
  }

  function loopConditionValues(loop, value) {
    return { counter: value, bound: loop.stop };
  }

  function loopMetadata(loopContext, value, result, bodyLine, round) {
    return {
      loopId: loopContext.id,
      round: round == null ? loopContext.round : round,
      counterName: loopContext.variable,
      counterBefore: value,
      counterAfter: value,
      conditionText: loopContext.conditionText,
      conditionResult: result,
      conditionValues: result == null ? null : loopConditionValues(loopContext, value),
      bodyLine: bodyLine == null ? loopContext.bodyLine : bodyLine,
      totalRounds: loopContext.totalRounds,
      completedRounds: loopContext.completedRounds,
      loopLanguage: loopContext.language,
      incrementExpression: loopContext.incrementExpression
    };
  }

  function bodyMetadata(loopContext, ctx, bodyLine) {
    if (!loopContext) return { eventType: 'statement', bodyLine: null };
    var counterAfter = own(ctx.env, loopContext.variable) ? clone(ctx.env[loopContext.variable]) : loopContext.current;
    var metadata = loopMetadata(loopContext, loopContext.current, true, bodyLine, loopContext.round);
    metadata.eventType = 'body';
    metadata.counterAfter = counterAfter;
    return metadata;
  }

  function executeNodes(nodes, ctx, language, fallthroughLine, activeLoop) {
    for (var i = 0; i < nodes.length; i += 1) {
      var node = nodes[i];
      if (node.type === 'stmt') {
        ctx.nextLine = nodes[i + 1] ? nodes[i + 1].line : fallthroughLine;
        var statementFlow = executeStatement(node, ctx, language, activeLoop);
        if (statementFlow) return statementFlow;
      } else if (node.type === 'if') {
        var conditionText = node.header.replace(/^if\s*/, '').trim();
        if (conditionText[0] === '(' && conditionText[conditionText.length - 1] === ')') conditionText = conditionText.slice(1, -1).trim();
        var condition = evaluateCondition(conditionText, ctx.env, language);
        var selectedChildren = condition.result ? node.children : (node.elseChildren || []);
        var selectedLine = selectedChildren[0] ? selectedChildren[0].line : (nodes[i + 1] ? nodes[i + 1].line : fallthroughLine);
        ctx.nextLine = selectedLine;
        var ifMetadata = {
          event: 'condition',
          eventType: 'condition',
          condition: condition.details,
          conditionText: conditionText,
          conditionResult: condition.result,
          conditionValues: condition.details ? { left: condition.details.left, right: condition.details.right } : clone(ctx.env),
          nextLine: ctx.nextLine,
          teacher: activeLoop ? 'Round ' + activeLoop.round + ' checks this condition: it is ' + (condition.result ? 'true, so the if block runs.' : (node.elseChildren ? 'false, so the else block runs.' : 'false, so the block is skipped.')) : 'This line checks a condition before choosing the next block.'
        };
        if (activeLoop) {
          var activeIfMetadata = loopMetadata(activeLoop, activeLoop.current, condition.result, node.line, activeLoop.round);
          ifMetadata.loopId = activeIfMetadata.loopId;
          ifMetadata.round = activeIfMetadata.round;
          ifMetadata.counterName = activeIfMetadata.counterName;
          ifMetadata.counterBefore = activeIfMetadata.counterBefore;
          ifMetadata.counterAfter = activeIfMetadata.counterAfter;
          ifMetadata.bodyLine = node.line;
          ifMetadata.totalRounds = activeIfMetadata.totalRounds;
          ifMetadata.completedRounds = activeIfMetadata.completedRounds;
          ifMetadata.loopLanguage = activeIfMetadata.loopLanguage;
          ifMetadata.incrementExpression = activeIfMetadata.incrementExpression;
        }
        var branchWhy = condition.result ? 'The true branch runs next.' : (node.elseChildren ? 'The false branch runs the else block next.' : 'The false branch is skipped, then the simulator continues.');
        makeStep(ctx, node, condition.result ? 'The condition is true.' : 'The condition is false.', 'This line checks a simple condition.', 'condition: ' + (condition.result ? 'true' : 'false'), condition.details ? conditionExplanation(condition.details) : 'Condition "' + conditionText + '" evaluated ' + (condition.result ? 'true' : 'false') + ' with current values: ' + JSON.stringify(displayState(ctx.env)) + '.', branchWhy, ifMetadata);
        if (selectedChildren.length) {
          var branchFlow = executeNodes(selectedChildren, ctx, language, nodes[i + 1] ? nodes[i + 1].line : fallthroughLine, activeLoop);
          if (branchFlow) return branchFlow;
        }
      } else if (node.type === 'for') {
        var loop = language === 'python' ? parseRange(node.header, ctx.env) : parseCFor(node.header, ctx.env, language, ctx.types);
        var round = 0;
        var current = loop.start;
        var loopOperator = language === 'python' ? (loop.step > 0 ? '<' : '>') : loop.operator;
        var conditionAt = function () {
          if (language !== 'python' && loop.boundExpression) {
            var liveBound = evaluateForLanguage(loop.boundExpression, ctx.env, language);
            if (!Number.isInteger(liveBound)) fail('The C/C++ loop bound must remain a whole number.');
            if (liveBound !== loop.stop) fail('Changing the C/C++ loop bound during a loop is outside this safe subset.');
          }
          return conditionAllows(current, loopOperator, loop.stop);
        };
        var bodyLine = node.children[0] ? node.children[0].line : node.line;
        var afterLoopLine = nodes[i + 1] ? nodes[i + 1].line : (fallthroughLine == null ? null : fallthroughLine);
        var totalRounds = loopRoundCount(loop, loopOperator);
        var loopContext = {
          id: 'loop-' + (++ctx.loopSequence),
          variable: loop.variable,
          start: loop.start,
          stop: loop.stop,
          step: loop.step,
          operator: loopOperator,
          conditionText: loop.conditionText || loop.variable + ' ' + loopOperator + ' ' + display(loop.stop),
          bodyLine: bodyLine,
          afterLoopLine: afterLoopLine,
          current: current,
          round: 0,
          totalRounds: totalRounds,
          completedRounds: 0,
          language: language,
          incrementExpression: loop.incrementExpression || loop.variable + ' += ' + display(loop.step),
          rangeExpression: loop.rangeExpression || null
        };
        var initialResult = conditionAt();
        var summaryResult = language === 'python' && !initialResult ? null : initialResult;
        var summaryMetadata = loopMetadata(loopContext, current, summaryResult, bodyLine, 0);
        summaryMetadata.event = 'loop-start';
        summaryMetadata.eventType = 'loop-summary';
        summaryMetadata.counterBefore = language === 'python' ? current : clone(ctx.env[loop.variable]);
        summaryMetadata.counterAfter = summaryMetadata.counterBefore;
        summaryMetadata.condition = summaryResult == null ? null : { left: current, operator: loopOperator, right: loop.stop, result: initialResult, kind: language === 'python' ? 'range' : 'c-loop' };
        summaryMetadata.nextLine = node.line;
        if (language !== 'python') {
          summaryMetadata.target = loop.variable;
          summaryMetadata.before = loop.initializerBefore;
          summaryMetadata.after = loop.start;
          summaryMetadata.expression = loop.initializerExpression;
          summaryMetadata.evaluatedExpression = loop.initializerEvaluatedExpression || null;
        }
        summaryMetadata.teacher = language === 'python' ? 'This range supplies ' + totalRounds + ' item' + (totalRounds === 1 ? '' : 's') + '; the cursor starts at ' + display(current) + '.' : 'This loop will make ' + totalRounds + ' round' + (totalRounds === 1 ? '' : 's') + ' while ' + loopContext.conditionText + ' is true.';
        makeStep(ctx, node, 'The loop is ready.', language === 'python' ? 'This range can supply ' + totalRounds + ' item' + (totalRounds === 1 ? '' : 's') + '.' : 'This loop can run ' + totalRounds + ' total round' + (totalRounds === 1 ? '' : 's') + '.', 'The counter starts at ' + display(current) + '.', 'Before each round, the loop evaluates the range cursor or C condition safely.', 'The first loop check decides whether the body on line ' + bodyLine + ' runs.', summaryMetadata);
        var stoppedByBreak = false;
        var previousAfterLoopLine = ctx.afterLoopLine;
        ctx.afterLoopLine = afterLoopLine;
        while (conditionAt()) {
          round += 1;
          loopContext.round = round;
          loopContext.current = current;
          ctx.env[loop.variable] = current;
          var conditionMetadata = loopMetadata(loopContext, current, true, bodyLine, round);
          conditionMetadata.event = 'loop-round';
          conditionMetadata.eventType = 'condition';
          conditionMetadata.condition = { left: current, operator: loopOperator, right: loop.stop, result: true, kind: language === 'python' ? 'range' : 'c-loop' };
          conditionMetadata.nextLine = bodyLine;
          conditionMetadata.teacher = language === 'python' ? 'Round ' + round + ' gets the next range item ' + display(current) + ', so the body runs.' : 'Round ' + round + ' checks ' + loopContext.conditionText + ': it is true, so the body runs.';
          makeStep(ctx, node, 'Round ' + round + ' condition is true.', 'The loop checks its condition before this round.', 'condition: true', 'The condition is true because ' + display(current) + ' keeps the counter within the loop bound.', 'The simulator follows the loop body for round ' + round + '.', conditionMetadata);
          var bodyFlow = executeNodes(node.children, ctx, language, node.line, loopContext);
          if (bodyFlow === 'return') {
            ctx.afterLoopLine = previousAfterLoopLine;
            return 'return';
          }
          if (bodyFlow === 'break') {
            stoppedByBreak = true;
            break;
          }
          if (language !== 'python' && ctx.env[loop.variable] !== current) fail('Changing the C/C++ loop counter inside its body is not supported safely.');
          var before = own(ctx.env, loop.variable) ? clone(ctx.env[loop.variable]) : current;
          var nextCurrent = current + loop.step;
          var nextResult = conditionAllows(nextCurrent, loopOperator, loop.stop);
          if (language !== 'python' || nextResult) ctx.env[loop.variable] = nextCurrent;
          loopContext.completedRounds = round;
          var incrementMetadata = loopMetadata(loopContext, before, null, bodyLine, round);
          incrementMetadata.event = 'loop-increment';
          incrementMetadata.eventType = 'increment';
          incrementMetadata.counterBefore = before;
          incrementMetadata.counterAfter = language === 'python' && !nextResult ? null : nextCurrent;
          incrementMetadata.conditionResult = null;
          incrementMetadata.conditionValues = null;
          incrementMetadata.condition = null;
          incrementMetadata.rangeExhausted = language === 'python' && !nextResult;
          incrementMetadata.nextLine = node.line;
          incrementMetadata.teacher = language === 'python' ? (nextResult ? 'The range cursor advances from ' + display(before) + ' to the next item ' + display(nextCurrent) + '.' : 'The range has no next item after ' + display(before) + '; Python does not assign the stop value to the loop variable.') : 'After round ' + round + ', ' + loop.variable + ' changes from ' + display(before) + ' to ' + display(nextCurrent) + ' (' + loop.variable + ': ' + display(before) + ' -> ' + display(nextCurrent) + ').';
          makeStep(ctx, node, 'The loop applies its increment.', language === 'python' ? (nextResult ? 'The range increment advances the cursor to the next item.' : 'The range increment finds no next item because the range is exhausted.') : 'The loop advances its counter by ' + display(loop.step) + '.', language === 'python' && !nextResult ? loop.variable + ': ' + display(before) + ' remains the final item' : loop.variable + ': ' + display(before) + ' → ' + display(nextCurrent), 'The next round uses the fixed range step ' + display(loop.step) + '.', 'The loop checks its next cursor or C condition.', incrementMetadata);
          current = nextCurrent;
          loopContext.current = current;
        }
        loopContext.current = current;
        loopContext.completedRounds = round;
        var finalCounter = own(ctx.env, loop.variable) ? clone(ctx.env[loop.variable]) : null;
        var finalResult = stoppedByBreak || language === 'python' || round === 0 ? null : conditionAt();
        var exitMetadata = loopMetadata(loopContext, language === 'python' ? finalCounter : current, finalResult, bodyLine, round);
        exitMetadata.event = 'loop-end';
        exitMetadata.eventType = 'loop-exit';
        exitMetadata.counterBefore = finalCounter == null ? (language === 'python' ? null : current) : finalCounter;
        exitMetadata.counterAfter = null;
        exitMetadata.condition = finalResult == null ? null : { left: current, operator: loopOperator, right: loop.stop, result: false, kind: 'c-loop' };
        exitMetadata.conditionResult = finalResult;
        exitMetadata.conditionValues = finalResult == null ? null : loopConditionValues(loopContext, current);
        exitMetadata.rangeExhausted = language === 'python' && !stoppedByBreak;
        exitMetadata.stoppedByBreak = stoppedByBreak;
        exitMetadata.nextLine = afterLoopLine;
        if (language === 'python') exitMetadata.conditionText = loopContext.rangeExpression + ' exhausted';
        exitMetadata.teacher = stoppedByBreak ? 'The loop stops early because break was reached in round ' + round + '; no condition-false claim is added.' : language === 'python' ? (round === 0 ? 'The range is empty, so the body runs zero rounds.' : 'The range is exhausted after ' + round + ' round' + (round === 1 ? '' : 's') + '; Python keeps the last item in ' + loop.variable + ' and never assigns the stop value.') : round === 0 ? 'The first C/C++ condition check is false, so the body runs zero rounds.' : 'After ' + round + ' round' + (round === 1 ? '' : 's') + ', the loop stops because ' + loopContext.conditionText + ' is false when ' + loop.variable + ' is ' + display(current) + '.';
        makeStep(ctx, node, stoppedByBreak ? 'The loop exits early.' : language === 'python' ? 'The range is exhausted.' : round === 0 ? 'The loop has zero rounds.' : 'The loop condition is false.', stoppedByBreak ? 'The loop exits because its body reached break.' : language === 'python' ? 'The range has no next item; the final loop variable stays at the last real item.' : round === 0 ? 'The loop exits before its body runs.' : 'The loop checks its next counter value after the final round.', stoppedByBreak ? 'The loop stopped before another increment.' : language === 'python' ? 'The stop value is a range boundary, not a fabricated loop-variable state.' : round === 0 ? 'No body assignment or increment occurred.' : 'The loop is finished; its body will not run again.', stoppedByBreak ? 'The body used break, so the loop stops without checking another round.' : language === 'python' ? 'Range exhaustion is distinct from a C-style false counter condition.' : round === 0 ? 'The initial C/C++ condition was false.' : 'Condition ' + display(current) + ' ' + loopOperator + ' ' + display(loop.stop) + ' evaluated false, so the loop stops.', 'Execution continues after the loop.', exitMetadata);
         ctx.afterLoopLine = previousAfterLoopLine;
      }
    }
     return null;
   }

  /*
   * Generic mode is intentionally a source reader, not another interpreter.
   * It is used only after the small teaching parser cannot make a verified
   * trace.  These helpers recognize a few safe literal forms and visible
   * syntax markers, but never calculate an expression or choose an execution
   * path.
   */
  var genericReservedWords = Object.create(null);
  [
    'if', 'else', 'elif', 'for', 'while', 'switch', 'case', 'default', 'do',
    'break', 'continue', 'return', 'function', 'func', 'def', 'fn', 'class', 'struct',
    'enum', 'interface', 'public', 'private', 'protected', 'internal', 'static',
    'final', 'const', 'let', 'var', 'val', 'volatile', 'mutable', 'new', 'this',
    'self', 'super', 'true', 'false', 'True', 'False', 'null', 'None', 'NULL',
    'undefined', 'void', 'int', 'integer', 'float', 'double', 'decimal', 'char',
    'bool', 'boolean', 'byte', 'short', 'long', 'unsigned', 'signed', 'size_t',
    'number', 'bigint', 'symbol', 'object', 'unknown', 'never', 'any', 'readonly',
    'auto', 'string', 'String', 'std', 'namespace', 'using', 'include', 'import',
    'from', 'as', 'in', 'of', 'and', 'or', 'not', 'is', 'typeof', 'instanceof',
    'sizeof', 'try', 'catch', 'finally', 'throw', 'throws', 'async', 'await',
    'yield', 'with', 'package', 'extends', 'implements', 'template', 'typename',
    'print', 'printf', 'println', 'puts', 'console', 'log', 'System', 'out',
    'cout', 'cerr', 'endl', 'range', 'len', 'Math', 'Array', 'Object', 'Integer',
    'Boolean', 'Number', 'main'
  ].forEach(function (word) { genericReservedWords[word] = true; });

  function genericCommentFreeSource(source) {
    var blockComment = false;
    return source.split(/\r?\n/).map(function (line) {
      var output = '';
      var quote = null;
      for (var i = 0; i < line.length; i += 1) {
        var ch = line[i];
        var next = line[i + 1];
        if (blockComment) {
          if (ch === '*' && next === '/') { blockComment = false; i += 1; output += '  '; }
          else output += ch === '\t' ? '\t' : ' ';
          continue;
        }
        if (quote) {
          output += ch;
          if (ch === '\\' && i + 1 < line.length) { output += line[i + 1]; i += 1; }
          else if (ch === quote) quote = null;
          continue;
        }
        if (ch === '"' || ch === "'" || ch === '`') { quote = ch; output += ch; continue; }
        if (ch === '/' && next === '*') { blockComment = true; i += 1; output += '  '; continue; }
        if (ch === '/' && next === '/') { output += new Array(line.length - i + 1).join(' '); break; }
        if (ch === '#') {
          var directive = line.slice(i).replace(/^\s+/, '');
          if (directive.indexOf('#include') !== 0) { output += new Array(line.length - i + 1).join(' '); break; }
        }
        output += ch;
      }
      return output;
    });
  }

  function genericSourceRecords(source) {
    var raw = source.split(/\r?\n/);
    var cleaned = genericCommentFreeSource(source);
    var records = [];
    raw.forEach(function (line, index) {
      var text = line.trim();
      if (!text) return;
      var code = (cleaned[index] || '').trim();
      if (!code) return;
      records.push({ line: index + 1, text: text, code: code });
    });
    if (records.length > MAX_LINES) fail('Please keep a trace to 300 meaningful lines or fewer.');
    return records;
  }

  function genericQuotedLiteral(text) {
    var quote = text[0];
    var value = '';
    for (var i = 1; i < text.length; i += 1) {
      var ch = text[i];
      if (ch === quote) {
        if (text.slice(i + 1).trim()) return null;
        if (quote === '`' && value.indexOf('${') >= 0) return null;
        return { ok: true, value: value };
      }
      if (ch !== '\\') { value += ch; continue; }
      if (i + 1 >= text.length) return null;
      var escaped = text[++i];
      if (escaped === 'n') value += '\n';
      else if (escaped === 'r') value += '\r';
      else if (escaped === 't') value += '\t';
      else if (escaped === 'b') value += '\b';
      else if (escaped === 'f') value += '\f';
      else if (escaped === 'v') value += '\v';
      else if (escaped === '0') value += '\0';
      else if (escaped === 'u') {
        var hex = text.slice(i + 1, i + 5);
        if (!/^[0-9a-fA-F]{4}$/.test(hex)) return null;
        value += String.fromCharCode(parseInt(hex, 16));
        i += 4;
      } else if (escaped === '\\' || escaped === '"' || escaped === "'" || escaped === '`') value += escaped;
      else return null;
    }
    return null;
  }

  function genericLiteralParts(text) {
    var parts = [];
    var start = 0;
    var square = 0;
    var curly = 0;
    var quote = null;
    for (var i = 0; i < text.length; i += 1) {
      var ch = text[i];
      if (quote) {
        if (ch === '\\') i += 1;
        else if (ch === quote) quote = null;
        continue;
      }
      if (ch === '"' || ch === "'" || ch === '`') quote = ch;
      else if (ch === '[') square += 1;
      else if (ch === ']') { square -= 1; if (square < 0) return null; }
      else if (ch === '{') curly += 1;
      else if (ch === '}') { curly -= 1; if (curly < 0) return null; }
      else if (ch === ',' && square === 0 && curly === 0) {
        var part = text.slice(start, i).trim();
        if (!part) return null;
        parts.push(part);
        start = i + 1;
      }
    }
    if (quote || square || curly) return null;
    var last = text.slice(start).trim();
    if (last) parts.push(last);
    else if (text.trim()) return null;
    return parts;
  }

  function genericLiteral(text, depth) {
    if (depth == null) depth = 0;
    if (depth > 12) return null;
    var value = String(text == null ? '' : text).trim();
    if (!value) return null;
    if ((value[0] === '"' || value[0] === "'" || value[0] === '`')) return genericQuotedLiteral(value);
    if (/^(?:true|false|True|False)$/.test(value)) return { ok: true, value: value.toLowerCase() === 'true' };
    var numericText = value.replace(/_/g, '');
    var numericMatch = /^([-+]?(?:(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][-+]?\d+)?))(?:[fFdDlLuUnN]+)?$/.exec(numericText);
    if (numericMatch) {
      var number = Number(numericMatch[1]);
      return Number.isFinite(number) ? { ok: true, value: number } : null;
    }
    var constructedArray = /^new\s+[A-Za-z_$][\w$]*(?:\s*<[^>]*>)?\s*\[\s*\]\s*(\{[\s\S]*\})$/.exec(value);
    if (constructedArray) return genericLiteral(constructedArray[1], depth + 1);
    var open = value[0];
    var close = open === '[' ? ']' : open === '{' ? '}' : null;
    if (!close || value[value.length - 1] !== close) return null;
    var pieces = genericLiteralParts(value.slice(1, -1));
    if (!pieces || pieces.length > MAX_ARRAY_LENGTH) return null;
    var result = [];
    for (var i = 0; i < pieces.length; i += 1) {
      var item = genericLiteral(pieces[i], depth + 1);
      if (!item || !item.ok) return null;
      result.push(item.value);
    }
    return { ok: true, value: result };
  }

  function genericCodeSurface(text) {
    var output = '';
    var quote = null;
    for (var i = 0; i < text.length; i += 1) {
      var ch = text[i];
      if (quote) {
        output += ' ';
        if (ch === '\\' && i + 1 < text.length) { output += ' '; i += 1; }
        else if (ch === quote) quote = null;
      } else if (ch === '"' || ch === "'" || ch === '`') { quote = ch; output += ' '; }
      else output += ch;
    }
    return output;
  }

  function genericIdentifiers(text) {
    var surface = genericCodeSurface(text);
    var matches = /[A-Za-z_$][\w$]*/g;
    var declaredTypes = Object.create(null);
    var typeMatch;
    var typePattern = /\b(?:class|struct|interface|enum)\s+([A-Za-z_$][\w$]*)/g;
    while ((typeMatch = typePattern.exec(surface))) declaredTypes[typeMatch[1]] = true;
    var names = [];
    var match;
    while ((match = matches.exec(surface))) {
      var name = match[0];
      var before = surface.slice(0, match.index).replace(/\s+$/, '');
      var after = surface.slice(match.index + name.length).replace(/^\s+/, '');
      var immediateBefore = surface[match.index - 1] || '';
      if (/[0-9]/.test(immediateBefore) || genericReservedWords[name] || declaredTypes[name] || (before && before[before.length - 1] === '.') || after[0] === '(') continue;
      if (names.indexOf(name) < 0) names.push(name);
    }
    return names;
  }

  function genericDeclarationWord(text) {
    return /(?:^|\s|\*)(?:const|let|var|val|final|static|public|private|protected|volatile|unsigned|signed|long|short|int|integer|float|double|decimal|char|bool|boolean|byte|size_t|auto|string|String|std::string)\b/.test(text);
  }

  function genericTarget(left) {
    var value = left.trim();
    var lastOpen = value.lastIndexOf('(');
    if (lastOpen >= 0) value = value.slice(lastOpen + 1).trim();
    if (!value || /\./.test(value)) return null;
    var annotation = /(?:^|\s)([A-Za-z_$][\w$]*)\s*:\s*[^:]+$/.exec(value);
    if (annotation && !genericReservedWords[annotation[1]]) return { name: annotation[1], indexed: false };
    var simple = /^([A-Za-z_$][\w$]*)$/.exec(value);
    if (simple) return { name: simple[1], indexed: false };
    var indexed = /^([A-Za-z_$][\w$]*)\s*\[[^\]]*\]$/.exec(value);
    if (indexed) return { name: indexed[1], indexed: !genericDeclarationWord(value) };
    if (!genericDeclarationWord(value)) return null;
    var names = value.match(/[A-Za-z_$][\w$]*/g);
    if (!names || !names.length) return null;
    return { name: names[names.length - 1], indexed: false };
  }

  function genericAssignmentOperator(text, index) {
    var ch = text[index];
    var previous = text[index - 1] || '';
    var next = text[index + 1] || '';
    if (ch === ':' && next === '=') return ':=';
    if (ch === '=') {
      if (next === '=' || next === '>' || previous === '=' || previous === '!' || previous === '<' || previous === '>') return null;
      return '=';
    }
    if (/[+\-*\/%]/.test(ch) && next === '=') return ch + '=';
    return null;
  }

  function genericRhsEnd(text, start) {
    var square = 0;
    var curly = 0;
    var parens = 0;
    var quote = null;
    for (var i = start; i < text.length; i += 1) {
      var ch = text[i];
      if (quote) {
        if (ch === '\\') i += 1;
        else if (ch === quote) quote = null;
        continue;
      }
      if (ch === '"' || ch === "'" || ch === '`') quote = ch;
      else if (ch === '[') square += 1;
      else if (ch === ']') square -= 1;
      else if (ch === '{') curly += 1;
      else if (ch === '}') { if (!curly && !square && !parens) return i; curly -= 1; }
      else if (ch === '(') parens += 1;
      else if (ch === ')') { if (!parens && !square && !curly) return i; parens -= 1; }
      else if (!square && !curly && !parens && (ch === ';' || ch === ',')) return i;
    }
    return text.length;
  }

  function genericAssignments(text) {
    var assignments = [];
    var segmentStart = 0;
    var square = 0;
    var curly = 0;
    var parens = 0;
    var quote = null;
    for (var i = 0; i < text.length; i += 1) {
      var ch = text[i];
      if (quote) {
        if (ch === '\\') i += 1;
        else if (ch === quote) quote = null;
        continue;
      }
      if (ch === '"' || ch === "'" || ch === '`') { quote = ch; continue; }
      if (ch === '(') { parens += 1; segmentStart = i + 1; continue; }
      if (ch === ')') { if (parens) parens -= 1; segmentStart = i + 1; continue; }
      if (ch === '[') { square += 1; continue; }
      if (ch === ']') { if (square) square -= 1; continue; }
      if (ch === '{') { curly += 1; continue; }
      if (ch === '}') { if (curly) curly -= 1; segmentStart = i + 1; continue; }
      if (ch === ';' || (ch === ',' && !square && !curly && !parens)) { segmentStart = i + 1; continue; }
      var operator = genericAssignmentOperator(text, i);
      if (!operator) continue;
      var left = text.slice(segmentStart, i).trim();
      var rhsStart = i + operator.length;
      var rhsEnd = genericRhsEnd(text, rhsStart);
      if (left) assignments.push({ left: left, op: operator, rhs: text.slice(rhsStart, rhsEnd).trim() });
    }
    return assignments;
  }

  function genericIncrementTargets(text) {
    var surface = genericCodeSurface(text);
    var matches = /(?:\+\+|--)\s*([A-Za-z_$][\w$]*)|([A-Za-z_$][\w$]*)\s*(?:\+\+|--|[+\-]=)/g;
    var names = [];
    var match;
    while ((match = matches.exec(surface))) {
      var name = match[1] || match[2];
      if (name && !genericReservedWords[name] && names.indexOf(name) < 0) names.push(name);
    }
    return names;
  }

  function genericRecordChange(facts, name, kind, value) {
    for (var i = 0; i < facts.changes.length; i += 1) {
      if (facts.changes[i].name === name) {
        facts.changes[i].kind = kind;
        facts.changes[i].value = value;
        return;
      }
    }
    facts.changes.push({ name: name, kind: kind, value: value });
  }

  function genericApplyFacts(code, state) {
    var facts = { changes: [], unknownReferences: [] };
    genericAssignments(code).forEach(function (assignment) {
      var target = genericTarget(assignment.left);
      if (!target || !target.name) return;
      var name = target.name;
      if ((assignment.op === '=' || assignment.op === ':=') && !target.indexed) {
        var literal = genericLiteral(assignment.rhs);
        if (literal && literal.ok) {
          state[name] = clone(literal.value);
          genericRecordChange(facts, name, 'literal', clone(literal.value));
        } else {
          state[name] = '?';
          genericRecordChange(facts, name, 'unknown', '?');
        }
      } else {
        state[name] = '?';
        genericRecordChange(facts, name, 'unknown', '?');
      }
      genericIdentifiers(assignment.rhs).forEach(function (reference) {
        if (reference === name) return;
        if (!own(state, reference)) state[reference] = '?';
        if (facts.unknownReferences.indexOf(reference) < 0) facts.unknownReferences.push(reference);
      });
    });
    genericIncrementTargets(code).forEach(function (name) {
      state[name] = '?';
      genericRecordChange(facts, name, 'unknown', '?');
    });
    if (!/^\s*(?:#|import\b|package\b|using\b|namespace\b)/.test(code)) {
      genericIdentifiers(code).forEach(function (name) {
        if (!own(state, name)) {
          state[name] = '?';
          if (facts.unknownReferences.indexOf(name) < 0) facts.unknownReferences.push(name);
        }
      });
    }
    return facts;
  }

  function genericFunctionIndex(surface) {
    var definition = /\b(?:function|def|fn)\s+[A-Za-z_$][\w$]*\s*\(/.exec(surface);
    if (definition) return definition.index;
    var anonymous = /\bfunction\s*\(/.exec(surface);
    if (anonymous) return anonymous.index;
    var arrow = /=>/.exec(surface);
    if (arrow) return arrow.index;
    var calls = /\b([A-Za-z_$][\w$]*)\s*\(/g;
    var blocked = { if: true, for: true, while: true, switch: true, catch: true, with: true, function: true, def: true, fn: true };
    var call;
    while ((call = calls.exec(surface))) if (!blocked[call[1]]) return call.index;
    return -1;
  }

  function genericExtraEvents(code) {
    if (/^\s*#/.test(code)) return [];
    var surface = genericCodeSurface(code);
    var events = [];
    var controls = /\b(for|while|if|else|switch|case|default|do)\b/g;
    var control;
    while ((control = controls.exec(surface))) events.push({ eventType: 'condition', detail: 'the ' + control[1] + ' control-flow marker', index: control.index, priority: 1 });
    var functionIndex = genericFunctionIndex(surface);
    if (functionIndex >= 0) events.push({ eventType: 'function', detail: 'a function definition or call', index: functionIndex, priority: 2 });
    var returnMatch = /\breturn\b/.exec(surface);
    if (returnMatch) events.push({ eventType: 'return', detail: 'a return statement', index: returnMatch.index, priority: 3 });
    var incrementMatch = /(?:\+\+|--|\+=|-=)/.exec(surface);
    if (incrementMatch) events.push({ eventType: 'increment', detail: 'an increment or decrement marker', index: incrementMatch.index, priority: 4 });
    for (var i = 0; i < surface.length; i += 1) {
      if (surface[i] === '{') events.push({ eventType: 'body', detail: 'an opening brace for a block boundary', index: i, priority: 5 });
      else if (surface[i] === '}') events.push({ eventType: 'body', detail: 'a closing brace for a block boundary', index: i, priority: 5 });
    }
    events.sort(function (a, b) { return a.index - b.index || a.priority - b.priority; });
    return events;
  }

  function genericBaseEventType(code, extras, facts) {
    if (!code) return 'unknown';
    var hasControl = extras.some(function (item) { return item.eventType === 'condition'; });
    if (hasControl) return 'condition';
    if (extras.some(function (item) { return item.eventType === 'function'; })) return 'function';
    if (extras.some(function (item) { return item.eventType === 'return'; })) return 'return';
    if (extras.some(function (item) { return item.eventType === 'increment'; })) return 'increment';
    if (facts.changes.length) return 'statement';
    if (extras.some(function (item) { return item.eventType === 'body'; })) return 'body';
    if (/[A-Za-z_$][\w$]*|\d|["'`]/.test(code)) return 'statement';
    return 'unknown';
  }

  function genericDisplayState(state) {
    var displayed = Object.create(null);
    Object.keys(state).forEach(function (key) { displayed[key] = state[key] === '?' ? '?' : display(state[key]); });
    return displayed;
  }

  function genericSnippet(text) {
    var value = String(text == null ? '' : text).trim();
    return value.length > 240 ? value.slice(0, 237) + '...' : value;
  }

  function genericChangedText(facts) {
    if (!facts.changes.length) {
      return facts.unknownReferences.length ? 'Unknown values stay ?; generic mode does not infer their runtime contents.' : 'No verified runtime value is recorded for this line.';
    }
    return facts.changes.map(function (change) {
      return change.kind === 'literal' ? 'Source literal observed for ' + change.name + ': ' + display(change.value) + ' (runtime not verified).' : change.name + ' is preserved as ? because its value is not a safe literal here.';
    }).join(' ');
  }

  function genericStep(record, eventType, detail, state, facts, base) {
    var code = record.code;
    var sourceText = genericSnippet(record.text);
    var isUnknown = eventType === 'unknown';
    var confidence = isUnknown ? 'unknown' : (base && eventType === 'statement' ? 'observed' : 'inferred');
    var what;
    var changed;
    var why = 'Generic mode follows visible syntax without executing source code.';
    var teacher;
    if (base) {
      what = code ? 'This generic step records source line ' + record.line + ' as part of the code story.' : 'This source line is preserved as text, but its meaning is unknown in generic mode.';
      changed = genericChangedText(facts);
      teacher = code ? 'Observed source text: ' + sourceText + '. Generic mode does not claim a verified runtime result.' : 'The source line is present, but generic mode cannot infer its runtime meaning.';
    } else if (eventType === 'condition') {
      what = 'The source visibly contains ' + detail + '.';
      changed = 'No true/false result or execution path is claimed.';
      why = 'Generic mode records the control-flow story without evaluating its condition.';
      teacher = 'Inferred from syntax: ' + detail + '. The runtime branch or loop path remains unknown.';
    } else if (eventType === 'body') {
      what = 'The source visibly contains ' + detail + '.';
      changed = 'No runtime block entry or exit is claimed.';
      why = 'A brace is a visible block boundary, not proof that the block executes.';
      teacher = 'Inferred from syntax: ' + detail + '. Generic mode does not enter or leave blocks.';
    } else if (eventType === 'function') {
      what = 'The source visibly contains ' + detail + '.';
      changed = 'No call, definition entry, or function result is executed.';
      why = 'Generic mode names function structure without invoking source code.';
      teacher = 'Inferred from syntax: ' + detail + '. Calls and definitions remain unexecuted in generic mode.';
    } else if (eventType === 'return') {
      what = 'The source visibly contains a return statement.';
      changed = 'No runtime return value or path is claimed.';
      why = 'A return marker describes source intent, but generic mode cannot verify which call reaches it.';
      teacher = 'Inferred from syntax: return is present. Its runtime value and reachability are unknown.';
    } else if (eventType === 'increment') {
      what = 'The source visibly contains an increment or decrement marker.';
      changed = 'The next value is preserved as ?; generic mode does not calculate it.';
      why = 'An increment depends on runtime control flow, so the fallback keeps the value unknown.';
      teacher = 'Inferred from syntax: an increment or decrement is present. No runtime counter value is claimed.';
    } else {
      what = 'This source marker is preserved as an unknown part of the code story.';
      changed = 'No runtime meaning or value is inferred.';
      teacher = 'The syntax is unknown to the teaching parser, so generic mode records it without execution claims.';
    }
    var step = {
      line: record.line,
      title: base ? 'The generic trace records this source line.' : 'The generic trace notes ' + detail + '.',
      what: what,
      changed: changed,
      why: why,
      next: '',
      caption: 'Generic code story: ' + what + ' ' + changed,
      nextLine: null,
      teacher: teacher,
      event: eventType,
      eventType: eventType,
      source: sourceText,
      syntaxDetail: detail,
      confidence: confidence,
      generic: true,
      state: clone(state),
      vars: genericDisplayState(state),
      output: []
    };
    return step;
  }

  function genericTrace(source, language) {
    var records = genericSourceRecords(source);
    var state = Object.create(null);
    var entries = [];
    var extraCount = 0;
    records.forEach(function (record) {
      var facts = genericApplyFacts(record.code, state);
      var extras = genericExtraEvents(record.code);
      entries.push({ record: record, facts: facts, extras: extras, state: clone(state), baseType: genericBaseEventType(record.code, extras, facts) });
      extraCount += extras.length;
    });
    var maximumExtras = Math.max(0, MAX_TRACE_STEPS - records.length - 1);
    var omittedExtras = extraCount > maximumExtras;
    var keptExtras = 0;
    var steps = [];
    entries.forEach(function (entry) {
      steps.push(genericStep(entry.record, entry.baseType, 'this source line', entry.state, entry.facts, true));
      entry.extras.forEach(function (extra) {
        if (keptExtras >= maximumExtras) return;
        steps.push(genericStep(entry.record, extra.eventType, extra.detail, entry.state, entry.facts, false));
        keptExtras += 1;
      });
    });
    var lastRecord = records.length ? records[records.length - 1] : { line: 1, text: '', code: '' };
    var limitationWhat = omittedExtras ? 'The generic trace reached its 5,000-step safety limit, so some syntax markers were omitted.' : 'This final note records the limit of generic tracing.';
    var limitationTeacher = 'Limitation: generic mode shows the code story, not a verified runtime result. It never executes pasted source.';
    steps.push({
      line: lastRecord.line,
      title: 'Generic mode limitation.',
      what: limitationWhat,
      changed: 'No runtime result was computed or verified.',
      why: 'The fallback is syntax-guided and keeps unsupported or unknown behavior visible as a story rather than an execution claim.',
      next: 'The generic trace ends here; runtime behavior was not verified.',
      caption: 'Generic mode shows the code story, not a verified runtime result.',
      nextLine: null,
      teacher: limitationTeacher,
      event: 'limitation',
      eventType: 'unknown',
      confidence: 'unknown',
      generic: true,
      limitation: true,
      state: clone(state),
      vars: genericDisplayState(state),
      output: []
    });
    var sourceLines = source.split(/\r?\n/);
    steps.forEach(function (step, index) {
      var following = steps[index + 1];
      if (!following || step.limitation) return;
      step.nextLine = following.line;
      var followingSource = genericSnippet(sourceLines[following.line - 1]);
      step.next = 'Next, the generic trace describes source line ' + following.line + (followingSource ? ': ' + followingSource : '.') + ' It does not verify runtime behavior.';
    });
    var label = String(language || 'Python').trim() || 'Python';
    var summary = 'Generic mode shows the code story, not a verified runtime result. It records ' + records.length + ' meaningful source line' + (records.length === 1 ? '' : 's') + ' for ' + label + ' without executing the source.';
    if (omittedExtras) summary += ' The 5,000-step limit omitted some additional syntax markers.';
    return { codeLines: source.split(/\r?\n/), steps: steps, events: steps, summary: summary, bugExample: null, generic: true, language: label };
  }

  function genericFallback(source, language) {
    try {
      return genericTrace(source, language);
    } catch (error) {
      return safeError(error instanceof TraceError ? error.message : 'The generic trace could not be created safely.', source.split(/\r?\n/), language || null);
    }
  }

  function safeError(message, codeLines, language) {
    return {
      codeLines: codeLines || [],
      steps: [],
      events: [],
      summary: message,
      bugExample: null,
      error: { type: 'unsupported-syntax', message: message, language: language || null }
    };
  }

  function createTrace(source, language) {
    var codeLines = typeof source === 'string' ? source.split(/\r?\n/) : [];
    if (typeof source !== 'string' || !source.trim()) return safeError('Paste a small Python, C, or C++ program to create a trace.', codeLines, typeof language === 'string' ? language : null);
    if (source.length > MAX_SOURCE_LENGTH) return safeError('Please keep the pasted program to 30,000 characters or fewer.', codeLines, typeof language === 'string' ? language : null);
    var cleanedSource = genericCommentFreeSource(source);
    var meaningfulLines = source.split(/\r?\n/).filter(function (line, index) { return line.trim() && (cleanedSource[index] || '').trim(); }).length;
    if (meaningfulLines > MAX_LINES) return safeError('Please keep a trace to 300 meaningful lines or fewer.', codeLines, typeof language === 'string' ? language : null);
    var label = String(language || 'Python').trim() || 'Python';
    var lang;
    try {
      lang = normalLanguage(language);
    } catch (_) {
      return genericFallback(source, label);
    }
    try {
      var tree = lang === 'python' ? parsePython(source) : parseC(source);
      var context = { env: Object.create(null), types: Object.create(null), output: [], steps: [], codeLines: codeLines, loopSequence: 0, afterLoopLine: null };
      executeNodes(tree, context, lang);
      if (!context.steps.length) fail('The program did not contain a supported executable statement.');
      finalizeSteps(context);
      var summary = context.output.length ? 'The program completed with output: ' + context.output.join(' ') + '.' : 'The program completed without producing output.';
      return { codeLines: codeLines, steps: context.steps, events: context.steps, summary: summary, bugExample: null };
    } catch (_) {
      return genericFallback(source, label);
    }
  }

  root.CodeFlowTraceEngine = { createTrace: createTrace };
}(typeof globalThis !== 'undefined' ? globalThis : typeof window !== 'undefined' ? window : this));
