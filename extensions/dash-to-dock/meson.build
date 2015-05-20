extension_data += configure_file(
  input: metadata_name + '.in',
  output: metadata_name,
  configuration: metadata_conf
)

extension_sources += files([
  'appIcons.js',
  'convenience.js',
  'dash.js',
  'dockedDash.js',
  'docking.js',
  'extension.js',
  'intellihide.js',
  'prefs.js',
  'theming.js',
  'utils.js',
  'windowPreview.js'])
extension_schemas += files(metadata_conf.get('gschemaname') + '.gschema.xml')

install_data('media/logo.svg', install_dir: join_paths(extensiondir, uuid, 'media')
