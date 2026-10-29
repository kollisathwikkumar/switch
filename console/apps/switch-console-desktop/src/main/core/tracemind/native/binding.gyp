{
  'targets': [
    {
      'target_name': 'tracemind_fs',
      'sources': [],
      'msvs_settings': {
        'VCCLCompilerTool': {
          'AdditionalOptions': [ '/std:c11' ],
        },
      },
      'conditions': [
        ['OS=="win"', { 'sources': [ 'windows-fs.c' ] }, { 'sources': [ 'posix-fs.c' ] }],
        ['OS=="linux"', { 'defines': [ '_GNU_SOURCE' ] }],
        ['OS=="mac"', { 'defines': [ '_DARWIN_C_SOURCE' ] }],
      ],
    },
  ],
}
