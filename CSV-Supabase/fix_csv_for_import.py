#!/usr/bin/env python3
"""
Script to fix CSV files for Supabase import
แก้ไขไฟล์ CSV ให้พร้อมสำหรับการนำเข้าข้อมูล
"""

import csv
import sys
import os
from pathlib import Path

def fix_cartoon_patterns(input_file, output_file):
    """Fix cp_cartoon_patterns CSV - remove pattern_code column (no longer needed)"""
    print(f"Processing {input_file}...")
    
    with open(input_file, 'r', encoding='utf-8') as infile, \
         open(output_file, 'w', encoding='utf-8', newline='') as outfile:
        
        reader = csv.DictReader(infile)
        # Remove pattern_code column - no longer needed
        fieldnames = ['id', 'pattern_name', 'image_url', 'is_active', 'created_at']
        writer = csv.DictWriter(outfile, fieldnames=fieldnames)
        
        writer.writeheader()
        
        for row in reader:
            new_row = {
                'id': row.get('id', ''),
                'pattern_name': row.get('pattern_name', '').strip(),
                'image_url': row.get('image_url', ''),
                'is_active': row.get('is_active', 'true'),
                'created_at': row.get('created_at', '')
            }
            writer.writerow(new_row)
    
    print(f"[OK] Fixed {input_file} -> {output_file}")
    print(f"  Removed pattern_code column (no longer needed)")

def fix_channels(input_file, output_file):
    """Fix channels CSV - remove id column (migration adds missing columns)"""
    print(f"Processing {input_file}...")
    
    with open(input_file, 'r', encoding='utf-8') as infile, \
         open(output_file, 'w', encoding='utf-8', newline='') as outfile:
        
        reader = csv.DictReader(infile)
        # Remove id column - let database generate UUID
        fieldnames = ['channel_code', 'channel_name', 'last_used_prefix', 'bank_account', 'created_at']
        
        writer = csv.DictWriter(outfile, fieldnames=fieldnames)
        writer.writeheader()
        
        for row in reader:
            new_row = {
                'channel_code': row.get('channel_code', ''),
                'channel_name': row.get('channel_name', ''),
                'last_used_prefix': row.get('last_used_prefix', ''),
                'bank_account': row.get('bank_account', ''),
                'created_at': row.get('created_at', '')
            }
            writer.writerow(new_row)
    
    print(f"[OK] Fixed {input_file} -> {output_file}")
    print(f"  Removed id column (will be auto-generated as UUID)")

def fix_products(input_file, output_file):
    """Fix pr_products CSV - remove numeric id, add legacy_id"""
    print(f"Processing {input_file}...")
    
    with open(input_file, 'r', encoding='utf-8') as infile, \
         open(output_file, 'w', encoding='utf-8', newline='') as outfile:
        
        reader = csv.DictReader(infile)
        # Remove id, add legacy_id, add updated_at
        fieldnames = [
            'product_code', 'product_name', 'product_type', 'product_category',
            'storage_location', 'rubber_code', 'is_active', 'image_url',
            'legacy_id', 'created_at', 'updated_at'
        ]
        
        writer = csv.DictWriter(outfile, fieldnames=fieldnames)
        writer.writeheader()
        
        for row in reader:
            old_id = row.get('id', '').strip()
            
            new_row = {
                'product_code': row.get('product_code', ''),
                'product_name': row.get('product_name', ''),
                'product_type': row.get('product_type', ''),
                'product_category': row.get('product_category', ''),
                'storage_location': row.get('storage_location', ''),
                'rubber_code': row.get('rubber_code', ''),
                'is_active': row.get('is_active', 'true'),
                'image_url': row.get('image_url', ''),
                'legacy_id': old_id,  # Store old numeric ID
                'created_at': row.get('created_at', ''),
                'updated_at': row.get('created_at', '')  # Use created_at as updated_at
            }
            writer.writerow(new_row)
    
    print(f"[OK] Fixed {input_file} -> {output_file}")
    print(f"  Removed numeric id, added legacy_id column")

def main():
    """Main function"""
    base_dir = Path(__file__).parent
    
    # Fix cartoon_patterns
    input_file = base_dir / 'cartoon_patterns_rows.csv'
    output_file = base_dir / 'cartoon_patterns_rows_fixed.csv'
    if input_file.exists():
        fix_cartoon_patterns(input_file, output_file)
    else:
        print(f"⚠ File not found: {input_file}")
    
    # Fix channels
    input_file = base_dir / 'channels_rows.csv'
    output_file = base_dir / 'channels_rows_fixed.csv'
    if input_file.exists():
        fix_channels(input_file, output_file)
    else:
        print(f"⚠ File not found: {input_file}")
    
    # Fix products
    input_file = base_dir / 'products_rows.csv'
    output_file = base_dir / 'products_rows_fixed.csv'
    if input_file.exists():
        fix_products(input_file, output_file)
    else:
        print(f"⚠ File not found: {input_file}")
    
    print("\n" + "="*60)
    print("[OK] All CSV files have been fixed!")
    print("="*60)
    print("\nNext steps:")
    print("1. Run migration: 005_fix_csv_import_issues.sql")
    print("2. Import the fixed CSV files (*_fixed.csv) to Supabase")
    print("3. For cp_cartoon_patterns: Import cartoon_patterns_rows_fixed.csv")
    print("4. For channels: Import channels_rows_fixed.csv")
    print("5. For pr_products: Import products_rows_fixed.csv")

if __name__ == '__main__':
    main()
