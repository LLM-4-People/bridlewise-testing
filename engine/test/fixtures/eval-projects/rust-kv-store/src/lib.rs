use std::collections::HashMap;

pub struct KvStore {
    entries: Vec<(String, String)>,
}

impl KvStore {
    pub fn new() -> Self {
        KvStore { entries: Vec::new() }
    }

    pub fn insert(&mut self, key: String, value: String) {
        for entry in &mut self.entries {
            if entry.0 == key {
                entry.1 = value;
                return;
            }
        }
        self.entries.push((key, value));
    }

    pub fn get(&self, key: &str) -> Option<&String> {
        for entry in &self.entries {
            if entry.0 == key {
                return Some(&entry.1);
            }
        }
        None
    }

    pub fn remove(&mut self, key: &str) -> bool {
        if let Some(pos) = self.entries.iter().position(|e| e.0 == key) {
            self.entries.remove(pos);
            true
        } else {
            false
        }
    }

    pub fn len(&self) -> usize {
        self.entries.len()
    }
}

impl Default for KvStore {
    fn default() -> Self {
        Self::new()
    }
}
