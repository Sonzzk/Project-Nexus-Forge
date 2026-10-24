import { AppError } from '@shared/errors';

// Windows cannot run .cmd or .bat files without a command interpreter (Node's child_process docs), and many npm-installed
// CLIs are .cmd shims. The runner starts them as `%ComSpec% /d /s /c ""<file>" <args>"` only when every argument and the
// path pass a strict character check, and refuses otherwise. Free text such as prompts goes through stdin, never the
// command line (ARCHITECTURE.md section 12, D-025).

const SHIM = /\.(cmd|bat)$/i;
/** Drive-letter paths without anything cmd.exe would interpret. Spaces are fine: the path is quoted. */
const SAFE_SHIM_PATH = /^[A-Za-z]:\\[^"%^&|<>!\r\n\0]*$/;
const SAFE_SHIM_ARG = /^[A-Za-z0-9_\-./:=@+,\\]+$/;

export interface PreparedCommand {
  file: string;
  args: string[];
  /** Node must not add its own quoting to `args` (used for the cmd.exe form). */
  verbatim: boolean;
}

export function prepareCommand(
  command: { executable: string; args: readonly string[] },
  environment: { platform: NodeJS.Platform; comspec: string },
): PreparedCommand {
  const { executable, args } = command;
  if (environment.platform !== 'win32' || !SHIM.test(executable))
    return { file: executable, args: [...args], verbatim: false };

  if (!SAFE_SHIM_PATH.test(executable))
    throw new AppError(
      'INVALID_INPUT',
      `The program path contains characters that cmd.exe would interpret, so ${executable} was not started.`,
      {
        hint: 'Install the tool in a folder whose path has only letters, digits, spaces and common punctuation.',
      },
    );
  for (const arg of args)
    if (!SAFE_SHIM_ARG.test(arg))
      throw new AppError(
        'INVALID_INPUT',
        'An argument for a .cmd program contains characters that cmd.exe would interpret, so the program was not started.',
        {
          hint: 'Send prompts and other free text through standard input instead of the command line.',
          details: { executable },
        },
      );

  return {
    file: environment.comspec,
    args: ['/d', '/s', '/c', `""${executable}"${args.length > 0 ? ` ${args.join(' ')}` : ''}"`],
    verbatim: true,
  };
}
