//! Narrow ownership wrappers around Apple's public Accessibility/CoreFoundation APIs.
use std::{
    ffi::{c_char, c_void},
    ptr,
};
pub type Ref = *const c_void;
#[link(name = "CoreFoundation", kind = "framework")]
extern "C" {
    pub fn CFRelease(value: Ref);
    pub fn CFRetain(value: Ref) -> Ref;
    pub fn CFEqual(a: Ref, b: Ref) -> u8;
    pub fn CFGetTypeID(value: Ref) -> usize;
    fn CFStringGetTypeID() -> usize;
    fn CFStringCreateWithBytes(
        allocator: Ref,
        bytes: *const u8,
        length: isize,
        encoding: u32,
        external: u8,
    ) -> Ref;
    fn CFStringGetLength(value: Ref) -> isize;
    fn CFStringGetMaximumSizeForEncoding(length: isize, encoding: u32) -> isize;
    fn CFStringGetCString(value: Ref, buffer: *mut c_char, size: isize, encoding: u32) -> u8;
    fn CFArrayGetTypeID() -> usize;
    fn CFArrayGetCount(value: Ref) -> isize;
    fn CFArrayGetValueAtIndex(value: Ref, index: isize) -> Ref;
    fn CFNumberGetTypeID() -> usize;
    fn CFNumberGetValue(value: Ref, kind: isize, out: *mut c_void) -> u8;
    fn CFBooleanGetTypeID() -> usize;
    fn CFBooleanGetValue(value: Ref) -> u8;
    fn CFDataGetBytePtr(value: Ref) -> *const u8;
    pub static kCFBooleanTrue: Ref;
    pub static kCFBooleanFalse: Ref;
    fn CFDictionaryCreate(
        allocator: Ref,
        keys: *const Ref,
        values: *const Ref,
        count: isize,
        key_callbacks: Ref,
        value_callbacks: Ref,
    ) -> Ref;
}
#[link(name = "Carbon", kind = "framework")]
extern "C" {
    fn TISCopyCurrentKeyboardLayoutInputSource() -> Ref;
    fn TISGetInputSourceProperty(source: Ref, key: Ref) -> Ref;
    static kTISPropertyUnicodeKeyLayoutData: Ref;
    fn LMGetKbdType() -> u8;
    fn UCKeyTranslate(
        layout: Ref,
        key: u16,
        action: u16,
        modifiers: u32,
        keyboard: u32,
        options: u32,
        dead: *mut u32,
        capacity: usize,
        length: *mut usize,
        output: *mut u16,
    ) -> i32;
}
/// Resolve Command shortcuts using the active layout; fixed US key codes can
/// turn Command+A into Command+Q on AZERTY and are therefore unsafe.
pub fn command_key(letter: char) -> Option<u16> {
    unsafe {
        let source = Owned::take(TISCopyCurrentKeyboardLayoutInputSource())?;
        let data = TISGetInputSourceProperty(source.0, kTISPropertyUnicodeKeyLayoutData);
        if data.is_null() {
            return None;
        }
        let layout = CFDataGetBytePtr(data);
        if layout.is_null() {
            return None;
        }
        let mut matches = Vec::new();
        for key in 0..128u16 {
            let mut dead = 0u32;
            let mut length = 0usize;
            let mut text = [0u16; 4];
            if UCKeyTranslate(
                layout as _,
                key,
                0,
                1,
                LMGetKbdType() as u32,
                1,
                &mut dead,
                4,
                &mut length,
                text.as_mut_ptr(),
            ) == 0
                && length == 1
                && char::from_u32(text[0] as u32).is_some_and(|c| c.eq_ignore_ascii_case(&letter))
            {
                matches.push(key);
            }
        }
        if matches.len() == 1 {
            Some(matches[0])
        } else {
            None
        }
    }
}
#[link(name = "ApplicationServices", kind = "framework")]
extern "C" {
    pub fn AXIsProcessTrusted() -> u8;
    fn AXIsProcessTrustedWithOptions(options: Ref) -> u8;
    static kAXTrustedCheckOptionPrompt: Ref;
    pub fn AXUIElementCreateApplication(pid: i32) -> Ref;
    fn AXUIElementCopyAttributeValue(element: Ref, attribute: Ref, out: *mut Ref) -> i32;
    fn AXUIElementCopyActionNames(element: Ref, out: *mut Ref) -> i32;
    fn AXUIElementIsAttributeSettable(element: Ref, attribute: Ref, out: *mut u8) -> i32;
    fn AXUIElementSetAttributeValue(element: Ref, attribute: Ref, value: Ref) -> i32;
    fn AXUIElementPerformAction(element: Ref, action: Ref) -> i32;
    pub fn AXUIElementSetMessagingTimeout(element: Ref, timeout: f32) -> i32;
    fn CGEventCreateKeyboardEvent(source: Ref, key: u16, down: u8) -> Ref;
    fn CGEventSetFlags(event: Ref, flags: u64);
    fn CGEventPostToPid(pid: i32, event: Ref);
    pub fn CGEventSourceFlagsState(state: i32) -> u64;
}
pub struct Owned(pub Ref);
// AXUIElement and immutable CF objects are retained across threads. No AppKit objects cross threads.
unsafe impl Send for Owned {}
unsafe impl Sync for Owned {}
impl Clone for Owned {
    fn clone(&self) -> Self {
        unsafe { Self(CFRetain(self.0)) }
    }
}
impl Drop for Owned {
    fn drop(&mut self) {
        if !self.0.is_null() {
            unsafe { CFRelease(self.0) }
        }
    }
}
impl PartialEq for Owned {
    fn eq(&self, other: &Self) -> bool {
        unsafe { CFEqual(self.0, other.0) != 0 }
    }
}
impl Eq for Owned {}
impl Owned {
    pub unsafe fn take(value: Ref) -> Option<Self> {
        if value.is_null() {
            None
        } else {
            Some(Self(value))
        }
    }
    pub fn string(value: &str) -> Self {
        unsafe {
            Self(CFStringCreateWithBytes(
                ptr::null(),
                value.as_ptr(),
                value.len() as isize,
                0x08000100,
                0,
            ))
        }
    }
    pub fn attr(&self, name: &str) -> Option<Self> {
        unsafe {
            let name = Self::string(name);
            let mut value = ptr::null();
            if AXUIElementCopyAttributeValue(self.0, name.0, &mut value) == 0 {
                Self::take(value)
            } else {
                None
            }
        }
    }
    pub fn settable(&self, name: &str) -> bool {
        unsafe {
            let name = Self::string(name);
            let mut settable = 0;
            AXUIElementIsAttributeSettable(self.0, name.0, &mut settable) == 0 && settable != 0
        }
    }
    pub fn set(&self, name: &str, value: &Owned) -> bool {
        unsafe { AXUIElementSetAttributeValue(self.0, Self::string(name).0, value.0) == 0 }
    }
    pub fn set_bool(&self, name: &str, value: bool) -> bool {
        unsafe {
            AXUIElementSetAttributeValue(
                self.0,
                Self::string(name).0,
                if value {
                    kCFBooleanTrue
                } else {
                    kCFBooleanFalse
                },
            ) == 0
        }
    }
    pub fn action(&self, name: &str) -> bool {
        unsafe { AXUIElementPerformAction(self.0, Self::string(name).0) == 0 }
    }
    pub fn actions(&self) -> Vec<String> {
        unsafe {
            let mut value = ptr::null();
            if AXUIElementCopyActionNames(self.0, &mut value) != 0 {
                return vec![];
            }
            Self::take(value)
                .map(|a| a.array().iter().filter_map(Self::text).collect())
                .unwrap_or_default()
        }
    }
    pub fn array(&self) -> Vec<Self> {
        unsafe {
            if CFGetTypeID(self.0) != CFArrayGetTypeID() {
                return vec![];
            }
            let count = CFArrayGetCount(self.0).min(1501);
            (0..count)
                .filter_map(|i| Self::take(CFRetain(CFArrayGetValueAtIndex(self.0, i))))
                .collect()
        }
    }
    pub fn text(&self) -> Option<String> {
        unsafe {
            if CFGetTypeID(self.0) != CFStringGetTypeID() {
                return None;
            }
            let length = CFStringGetLength(self.0);
            if length > 100_000 {
                return None;
            }
            let size = CFStringGetMaximumSizeForEncoding(length, 0x08000100) + 1;
            let mut bytes = vec![0; size as usize];
            if CFStringGetCString(self.0, bytes.as_mut_ptr() as _, size, 0x08000100) == 0 {
                return None;
            }
            let end = bytes.iter().position(|b| *b == 0)?;
            String::from_utf8(bytes[..end].to_vec()).ok()
        }
    }
    pub fn number(&self) -> Option<i64> {
        unsafe {
            if CFGetTypeID(self.0) == CFBooleanGetTypeID() {
                return Some(CFBooleanGetValue(self.0) as i64);
            }
            if CFGetTypeID(self.0) != CFNumberGetTypeID() {
                return None;
            }
            let mut value = 0i64;
            if CFNumberGetValue(self.0, 4, &mut value as *mut _ as _) != 0 {
                Some(value)
            } else {
                None
            }
        }
    }
    pub fn label(&self, name: &str) -> String {
        self.attr(name).and_then(|s| s.text()).unwrap_or_default()
    }
    pub fn boolean(&self, name: &str) -> Option<bool> {
        self.attr(name).and_then(|s| s.number()).map(|n| n != 0)
    }
}
pub fn request_permission() -> bool {
    unsafe {
        let key = kAXTrustedCheckOptionPrompt;
        let value = kCFBooleanTrue;
        let dictionary = Owned(CFDictionaryCreate(
            ptr::null(),
            &key,
            &value,
            1,
            ptr::null(),
            ptr::null(),
        ));
        AXIsProcessTrustedWithOptions(dictionary.0) != 0
    }
}
pub fn keyboard(pid: i32, key: u16, command: bool, before_post: impl FnOnce() -> bool) -> bool {
    unsafe {
        let Some(down) = Owned::take(CGEventCreateKeyboardEvent(ptr::null(), key, 1)) else {
            return false;
        };
        let Some(up) = Owned::take(CGEventCreateKeyboardEvent(ptr::null(), key, 0)) else {
            return false;
        };
        let flags = if command { 1 << 20 } else { 0 };
        CGEventSetFlags(down.0, flags);
        CGEventSetFlags(up.0, flags);
        if !before_post() {
            return false;
        }
        CGEventPostToPid(pid, down.0);
        CGEventPostToPid(pid, up.0);
        true
    }
}
