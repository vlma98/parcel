// @flow strict-local

import {Transformer} from '@parcel/plugin';
import path from 'path';
import SourceMap from '@parcel/source-map';
import type {DiagnosticCodeFrame} from '@parcel/diagnostic';
import type {CompilerOptions} from 'typescript';

import ts from 'typescript';
import {CompilerHost, loadTSConfig} from '@parcel/ts-utils';
import {escapeMarkdown} from '@parcel/diagnostic';
import {TSModuleGraph} from './TSModuleGraph';
import nullthrows from 'nullthrows';
import {collect} from './collect';
import {shake} from './shake';

export default (new Transformer({
  async loadConfig({config, options}) {
    await loadTSConfig(config, options);
  },

  transform({asset, config, options, logger}) {
    let opts: CompilerOptions = {
      // React is the default. Users can override this by supplying their own tsconfig,
      // which many TypeScript users will already have for typechecking, etc.
      jsx: ts.JsxEmit.React,
      ...config,
      // Always emit output
      noEmit: false,
      noEmitOnError: false,
      declaration: true,
      declarationMap: true,
      isolatedModules: false,
      emitDeclarationOnly: true,
      outFile: 'index.d.ts',
      moduleResolution: ts.ModuleResolutionKind.NodeJs,
      // createProgram doesn't support incremental mode
      composite: false,
    };

    let host = new CompilerHost(options.inputFS, ts, logger);
    // $FlowFixMe
    let program = ts.createProgram([asset.filePath], opts, host);

    for (let file of program.getSourceFiles()) {
      if (path.normalize(file.fileName) !== asset.filePath) {
        asset.invalidateOnFileChange(
          host.redirectTypes.get(file.fileName) ?? file.fileName,
        );
      }
    }

    let mainModuleName = path
      .relative(program.getCommonSourceDirectory(), asset.filePath)
      .slice(0, -path.extname(asset.filePath).length);
    let moduleGraph = new TSModuleGraph(mainModuleName);

    let emitResult = program.emit(undefined, undefined, undefined, true, {
      afterDeclarations: [
        // 1. Build module graph
        context => sourceFile => {
          return collect(moduleGraph, context, sourceFile);
        },
        // 2. Tree shake and rename types
        context => sourceFile => {
          return shake(moduleGraph, context, sourceFile);
        },
      ],
    });

    let diagnostics = ts
      .getPreEmitDiagnostics(program)
      .concat(emitResult.diagnostics);

    if (diagnostics.length > 0) {
      for (let diagnostic of diagnostics) {
        let filename = asset.filePath;
        let {file} = diagnostic;

        let diagnosticMessage =
          typeof diagnostic.messageText === 'string'
            ? diagnostic.messageText
            : diagnostic.messageText.messageText;

        let codeframe: ?DiagnosticCodeFrame;
        if (file != null && diagnostic.start != null) {
          let source = file.text || diagnostic.source;
          if (file.fileName) {
            filename = file.fileName;
          }

          // $FlowFixMe
          if (source) {
            let lineChar = file.getLineAndCharacterOfPosition(diagnostic.start);
            let start = {
              line: lineChar.line + 1,
              column: lineChar.character + 1,
            };
            let end = {
              line: start.line,
              column: start.column + 1,
            };

            if (
              typeof diagnostic.start === 'number' &&
              typeof diagnostic.length === 'number'
            ) {
              let endCharPosition = file.getLineAndCharacterOfPosition(
                diagnostic.start + diagnostic.length,
              );

              end = {
                line: endCharPosition.line + 1,
                column: endCharPosition.character + 1,
              };
            }

            codeframe = {
              code: source,
              codeHighlights: [
                {
                  start,
                  end,
                  message: escapeMarkdown(diagnosticMessage),
                },
              ],
            };
          }
        }

        logger.warn({
          message: escapeMarkdown(diagnosticMessage),
          filePath: filename,
          codeFrame: codeframe ? codeframe : undefined,
        });
      }
    }

    let code = nullthrows(host.outputCode);
    code = code.substring(0, code.lastIndexOf('//# sourceMappingURL'));

    let map = JSON.parse(nullthrows(host.outputMap));
    map.sources = map.sources.map(source =>
      path.join(path.dirname(asset.filePath), source),
    );

    let sourceMap = null;
    if (map.mappings) {
      sourceMap = new SourceMap(options.projectRoot);
      sourceMap.addVLQMap(map);
    }

    asset.type = 'ts';
    asset.setCode(code);
    asset.setMap(sourceMap);
    return [asset];
  },
}): Transformer);
