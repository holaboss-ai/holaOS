#!/usr/bin/env ruby

require "fileutils"
require "yaml"

def usage!
  warn "Usage: ruby merge-mac-update-manifests.rb <output-path> <primary-manifest> <additional-manifest> [<additional-manifest> ...]"
  exit 1
end

def load_manifest(path)
  data = YAML.load_file(path)
  unless data.is_a?(Hash)
    raise "expected #{path} to contain a YAML object"
  end
  data
end

def normalize_file_entry(entry)
  unless entry.is_a?(Hash)
    raise "manifest file entry must be an object"
  end
  normalized = entry.transform_keys(&:to_s)
  url = normalized["url"].to_s.strip
  raise "manifest file entry is missing url" if url.empty?
  normalized["url"] = url
  normalized
end

def manifest_files(manifest)
  files = manifest["files"]
  if files.is_a?(Array) && !files.empty?
    return files.map { |entry| normalize_file_entry(entry) }
  end

  legacy_url = manifest["path"].to_s.strip
  raise "manifest is missing files and path" if legacy_url.empty?

  entry = { "url" => legacy_url }
  %w[sha512 sha2 size].each do |key|
    value = manifest[key]
    entry[key] = value unless value.nil?
  end
  [entry]
end

def merge_files(primary_files, additional_files)
  merged = []
  seen = {}

  (primary_files + additional_files).each do |entry|
    url = entry["url"]
    existing = seen[url]
    if existing
      if existing["sha512"] && entry["sha512"] && existing["sha512"] != entry["sha512"]
        raise "conflicting sha512 values for #{url}"
      end
      if existing["sha2"] && entry["sha2"] && existing["sha2"] != entry["sha2"]
        raise "conflicting sha2 values for #{url}"
      end
      existing.merge!(entry) { |_key, old_value, new_value| old_value.nil? ? new_value : old_value }
      next
    end

    duplicate = entry.dup
    merged << duplicate
    seen[url] = duplicate
  end

  merged
end

def validate_manifest_compatibility!(primary_manifest, additional_manifest, primary_path, additional_path)
  primary_version = primary_manifest["version"].to_s.strip
  additional_version = additional_manifest["version"].to_s.strip
  if !primary_version.empty? && !additional_version.empty? && primary_version != additional_version
    raise "manifest version mismatch between #{primary_path} (#{primary_version}) and #{additional_path} (#{additional_version})"
  end
end

output_path, primary_path, *additional_paths = ARGV
usage! if output_path.to_s.empty? || primary_path.to_s.empty? || additional_paths.empty?

primary_manifest = load_manifest(primary_path)
primary_files = manifest_files(primary_manifest)

merged_manifest = primary_manifest.transform_keys(&:to_s)

additional_paths.each do |additional_path|
  additional_manifest = load_manifest(additional_path)
  validate_manifest_compatibility!(
    merged_manifest,
    additional_manifest,
    primary_path,
    additional_path,
  )
  primary_files = merge_files(primary_files, manifest_files(additional_manifest))
end

merged_manifest["files"] = primary_files

first_file = primary_files.first
if first_file
  merged_manifest["path"] = first_file["url"]
  merged_manifest["sha512"] = first_file["sha512"] if first_file.key?("sha512")
  merged_manifest["sha2"] = first_file["sha2"] if first_file.key?("sha2")
end

FileUtils.mkdir_p(File.dirname(output_path))
File.write(output_path, YAML.dump(merged_manifest))
