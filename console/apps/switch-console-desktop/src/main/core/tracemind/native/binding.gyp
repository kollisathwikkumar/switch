{
  'targets': [
    {
      'target_name': 'tracemind_fs',
      'sources': [],
      'conditions': [
        ['OS=="win"', { 'sources': [ 'windows-fs.cc' ] }, { 'sources': [ 'posix-fs.c' ] }],
        ['OS=="linux"', { 'defines': [ '_GNU_SOURCE' ] }],
        ['OS=="mac"', { 'defines': [ '_DARWIN_C_SOURCE' ] }],
      ],
    },
  ],
}
