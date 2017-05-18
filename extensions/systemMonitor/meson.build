extension_data += configure_file(
  input: metadata_name + '.in',
  output: metadata_name,
  configuration: metadata_conf
)

if classic_mode_enabled
  extension_data += files('classic.css')
endif
